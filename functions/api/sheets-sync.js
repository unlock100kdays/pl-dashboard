/* ═══════════════════════════════════════════════════════════
   Cloudflare Pages Function — mirrors the dashboard into a Google Sheet.

   Auth: Google's service-account server-to-server flow (JWT signed with
   the service account's private key, exchanged for an OAuth access
   token). Implemented by hand with the standard Web Crypto API since
   Pages Functions run on the Workers runtime, not Node.js — no
   googleapis / jsonwebtoken dependency needed.

   Required environment variables (set in the Cloudflare dashboard,
   never committed to the repo):
     GOOGLE_SERVICE_ACCOUNT_EMAIL — the service account's client_email
     GOOGLE_SERVICE_ACCOUNT_KEY   — the service account's private_key
     GOOGLE_SHEET_ID              — the target spreadsheet's ID
   ═══════════════════════════════════════════════════════════ */

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

// Column layout per sheet that actually has a data source in the
// dashboard today — these get created AND kept in sync on every POST.
const SHEET_DEFS = {
  transactions: { title: 'Transactions', headers: ['Date', 'Type', 'Category', 'Project', 'Employee', 'Subscription', 'Vendor', 'Method', 'Amount', 'Currency', 'Notes'] },
  projects: { title: 'Projects', headers: ['Project Name', 'Revenue', 'Expenses', 'Profit', 'Status', 'Client'] },
  employees: { title: 'Employees', headers: ['Employee Name', 'Salary Type', 'Salary', 'Total Paid', 'Status'] },
  subscriptions: { title: 'Subscriptions', headers: ['Platform', 'Monthly Cost', 'Renewal Date', 'Payment Method', 'Status'] },
  paymentMethods: { title: 'Methods', headers: ['Payment Methods'] },
};

// Placeholder tabs for modules that don't exist in the dashboard yet —
// created with a sensible header row so the spreadsheet's shape is ready
// ahead of time, but never written to by onRequestPost since there's no
// data source for them. Will move into SHEET_DEFS once those modules
// (Vendors, Clients) or the corresponding concept (Settings) exist.
const PLACEHOLDER_SHEETS = [
  { title: 'Vendors', headers: ['Vendor', 'Category', 'Contact', 'GST/VAT', 'Total Paid'] },
  { title: 'Clients', headers: ['Client Name', 'Contact', 'Related Projects', 'Total Revenue'] },
  { title: 'Settings', headers: ['Setting', 'Value'] },
];

function base64url(input) {
  const str = typeof input === 'string' ? btoa(input) : btoa(String.fromCharCode(...new Uint8Array(input)));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  const cleaned = pem
    .replace(/\\n/g, '\n')                          // env vars sometimes keep the literal \n from the JSON key file
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const raw = atob(cleaned);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

async function getAccessToken(env) {
  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!email || !key) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_KEY');

  const now = Math.floor(Date.now() / 1000);
  const encHeader = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const encClaims = base64url(JSON.stringify({
    iss: email, scope: SHEETS_SCOPE, aud: TOKEN_URL, exp: now + 3600, iat: now,
  }));
  const signingInput = `${encHeader}.${encClaims}`;

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', pemToArrayBuffer(key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${base64url(signature)}`;

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Google auth failed: ${data.error_description || data.error || resp.status}`);
  return data.access_token;
}

async function sheetsFetch(path, token, opts = {}) {
  const resp = await fetch(`${SHEETS_API}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `Sheets API error ${resp.status}`);
  return data;
}

async function ensureSheetsExist(sheetId, token, existingTitles) {
  const allDefs = [...Object.values(SHEET_DEFS), ...PLACEHOLDER_SHEETS];
  const missing = allDefs.filter((d) => !existingTitles.includes(d.title));
  if (!missing.length) return;
  await sheetsFetch(`/${sheetId}:batchUpdate`, token, {
    method: 'POST',
    body: JSON.stringify({ requests: missing.map((d) => ({ addSheet: { properties: { title: d.title } } })) }),
  });
  for (const d of missing) {
    await sheetsFetch(`/${sheetId}/values/${encodeURIComponent(d.title)}!A1?valueInputOption=RAW`, token, {
      method: 'PUT',
      body: JSON.stringify({ values: [d.headers] }),
    });
  }
}

/** Clears everything below the header, then writes header + fresh rows in
 *  one call — a full resync rather than per-row append/update/delete, so
 *  a failed sync never leaves the sheet half-changed: the next sync just
 *  overwrites it correctly again. */
async function writeSheet(sheetId, token, title, headers, rows) {
  await sheetsFetch(`/${sheetId}/values/${encodeURIComponent(title)}!A2:ZZ:clear`, token, { method: 'POST', body: '{}' });
  await sheetsFetch(`/${sheetId}/values/${encodeURIComponent(title)}!A1?valueInputOption=RAW`, token, {
    method: 'PUT',
    body: JSON.stringify({ values: [headers, ...rows] }),
  });
  return { rows: rows.length };
}

const s = (v) => (v === undefined || v === null ? '' : String(v));
const n = (v) => Number(v) || 0;

export async function onRequestGet(context) {
  const { env } = context;
  try {
    const sheetId = env.GOOGLE_SHEET_ID;
    if (!sheetId) throw new Error('Missing GOOGLE_SHEET_ID');
    const token = await getAccessToken(env);
    const meta = await sheetsFetch(`/${sheetId}?fields=properties.title,sheets.properties.title`, token);
    return Response.json({
      ok: true,
      title: meta.properties?.title,
      sheets: (meta.sheets || []).map((sh) => sh.properties.title),
    });
  } catch (err) {
    return Response.json({ ok: false, error: String(err.message || err) }, { status: 500 });
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const sheetId = env.GOOGLE_SHEET_ID;
    if (!sheetId) throw new Error('Missing GOOGLE_SHEET_ID');
    const body = await request.json();
    const token = await getAccessToken(env);

    const meta = await sheetsFetch(`/${sheetId}?fields=sheets.properties.title`, token);
    const existingTitles = (meta.sheets || []).map((sh) => sh.properties.title);
    await ensureSheetsExist(sheetId, token, existingTitles);

    const results = {};

    if (Array.isArray(body.transactions)) {
      const rows = body.transactions.map((t) => [
        s(t.date), t.type === 'income' ? 'Money in' : 'Money out', s(t.category), s(t.project),
        s(t.employee), s(t.subscription), s(t.vendor), s(t.method), n(t.amount), s(t.currency), s(t.notes),
      ]);
      results.transactions = await writeSheet(sheetId, token, SHEET_DEFS.transactions.title, SHEET_DEFS.transactions.headers, rows);
    }
    if (Array.isArray(body.projects)) {
      const rows = body.projects.map((p) => [s(p.name), n(p.revenue), n(p.expenses), n(p.profit), s(p.status), s(p.client)]);
      results.projects = await writeSheet(sheetId, token, SHEET_DEFS.projects.title, SHEET_DEFS.projects.headers, rows);
    }
    if (Array.isArray(body.employees)) {
      const rows = body.employees.map((e) => [s(e.name), s(e.salaryType), n(e.salary), n(e.totalPaid), s(e.status)]);
      results.employees = await writeSheet(sheetId, token, SHEET_DEFS.employees.title, SHEET_DEFS.employees.headers, rows);
    }
    if (Array.isArray(body.subscriptions)) {
      const rows = body.subscriptions.map((sub) => [s(sub.platform), n(sub.monthlyCost), s(sub.renewalDate), s(sub.paymentMethod), s(sub.status)]);
      results.subscriptions = await writeSheet(sheetId, token, SHEET_DEFS.subscriptions.title, SHEET_DEFS.subscriptions.headers, rows);
    }
    if (Array.isArray(body.paymentMethods)) {
      const rows = body.paymentMethods.map((m) => [s(m)]);
      results.paymentMethods = await writeSheet(sheetId, token, SHEET_DEFS.paymentMethods.title, SHEET_DEFS.paymentMethods.headers, rows);
    }

    return Response.json({ ok: true, results });
  } catch (err) {
    return Response.json({ ok: false, error: String(err.message || err) }, { status: 500 });
  }
}
