/* ═══════════════════════════════════════════════════════════
   P&L Dashboard
   Client-side ledger: money in / money out, tagged by category
   and project, plus an employee roster and payroll runs.
   All state lives in localStorage — nothing leaves the browser.
   ═══════════════════════════════════════════════════════════ */

'use strict';

const STORE_KEY = 'pl-dashboard:v1';
const THEME_KEY = 'pl-dashboard:theme';

/* ── tiny helpers ──────────────────────────────────────── */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const sum = (arr, fn) => arr.reduce((a, x) => a + fn(x), 0);
/** Local-calendar ISO date (YYYY-MM-DD).
 *  NOT toISOString(), which converts to UTC first: east of Greenwich
 *  that reports *yesterday* between midnight and the UTC offset (e.g.
 *  until 05:30 in IST), which silently back-dated new entries, the
 *  "Today" filter and subscription renewals. */
const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayISO = () => isoLocal(new Date());

/* ── state ─────────────────────────────────────────────── */
const DEFAULT_CATEGORIES = [
  { name: 'Client revenue',        type: 'income'  },
  { name: 'Product sales',         type: 'income'  },
  { name: 'Retainers',             type: 'income'  },
  { name: 'Interest & other',      type: 'income'  },
  { name: 'Salaries & wages',      type: 'expense' },
  { name: 'Contractors',           type: 'expense' },
  { name: 'Software & tools',      type: 'expense' },
  { name: 'Marketing & ads',       type: 'expense' },
  { name: 'Rent & utilities',      type: 'expense' },
  { name: 'Travel',                type: 'expense' },
  { name: 'Equipment',             type: 'expense' },
  { name: 'Professional fees',     type: 'expense' },
  { name: 'Taxes',                 type: 'expense' },
];

const DEFAULT_METHODS = ['Bank transfer', 'Card', 'Cash', 'Cheque', 'PayPal', 'Stripe', 'Other'];

const blankState = () => ({
  settings: { company: 'My Company', currency: 'USD' },
  categories: DEFAULT_CATEGORIES.map((c) => ({ id: uid(), ...c })),
  projects: [],
  employees: [],
  transactions: [],
  payruns: [],
  subscriptions: [],
  paymentMethods: DEFAULT_METHODS.map((name) => ({ id: uid(), name })),
});

let state = load();
let ui = {
  view: 'overview',
  range: '12m',
  periodOffset: 0,      // 0 = current period, -1 = the one before it…
  customStart: '',
  customEnd: '',
  breakdownDir: 'expense',
  breakdownProject: '',
  detailEmployeeId: '',
  detailProjectId: '',
  txSearch: '',
  txType: '',
  txCat: '',
  txProj: '',
  txSort: { key: 'date', dir: -1 },
};

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return blankState();
    const parsed = JSON.parse(raw);
    return { ...blankState(), ...parsed, settings: { ...blankState().settings, ...(parsed.settings || {}) } };
  } catch {
    return blankState();
  }
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));   // offline cache only
  } catch (err) {
    toast('Could not save — browser storage is full', 'bad');
  }
  pushStateToServer();   // the server copy is the shared source of truth
}

/* ═══════════════════════════════════════════════════════
   Shared state sync
   localStorage is now only an offline cache; the KV record behind
   /api/state is what every device reads. Saves carry the version they
   were based on, so a second device can never silently clobber a first.
   ═══════════════════════════════════════════════════════ */
const STATE_ENDPOINT = '/api/state';
const pinHeaders = () => (apiPin ? { 'X-Dashboard-Pin': apiPin } : {});
let stateVersion = 0;         // version this client last saw from the server
let serverAvailable = false;  // false ⇒ running local-only (offline / no backend)
let pushTimer = null, pushing = false, pushQueued = false;

function setCloudStatus(mode, detail) {
  const el = $('#cloudStatus');
  if (!el) return;
  el.className = `cloud-status cloud-status--${mode}`;
  el.title = detail;
  const label = $('.cloud-label', el);
  if (label) label.textContent = { synced: 'Synced', saving: 'Saving…', offline: 'Local only', conflict: 'Out of date' }[mode] || '';
}

/** Pulls the shared record. Returns true when server state was applied. */
async function loadStateFromServer() {
  try {
    const r = await fetch(STATE_ENDPOINT, { cache: 'no-store', headers: pinHeaders() });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'unavailable');
    serverAvailable = true;
    stateVersion = d.version || 0;
    if (d.state && Array.isArray(d.state.transactions)) {
      state = { ...blankState(), ...d.state, settings: { ...blankState().settings, ...(d.state.settings || {}) } };
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* cache only */ }
      setCloudStatus('synced', `In sync with the shared copy (v${stateVersion})`);
      return true;
    }
    // server reachable but empty — this browser's local data seeds it
    setCloudStatus('synced', 'Shared copy is empty; this device will seed it');
    return false;
  } catch (err) {
    serverAvailable = false;
    setCloudStatus('offline', `Working from this browser only — ${String(err.message || err)}`);
    return false;
  }
}

function pushStateToServer() {
  if (!serverAvailable) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(doPush, 600);   // debounce bursts of edits into one write
}

async function doPush() {
  if (!serverAvailable) return;
  if (pushing) { pushQueued = true; return; }   // never overlap writes
  pushing = true;
  setCloudStatus('saving', 'Saving to the shared copy…');
  try {
    const r = await fetch(STATE_ENDPOINT, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...pinHeaders() },
      body: JSON.stringify({ state, baseVersion: stateVersion }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 409 && d.conflict) { handleConflict(d); return; }
    if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
    stateVersion = d.version;
    setCloudStatus('synced', `Saved to the shared copy (v${stateVersion})`);
  } catch (err) {
    setCloudStatus('offline', `Could not reach the shared copy — ${String(err.message || err)}`);
  } finally {
    pushing = false;
    if (pushQueued) { pushQueued = false; doPush(); }
  }
}

/** Another device saved first. Take their copy rather than overwrite it —
 *  losing one unsaved edit is recoverable, silently destroying someone
 *  else's whole session is not. */
function handleConflict(d) {
  setCloudStatus('conflict', 'Another device saved first — reloading the newer copy');
  if (d.state && Array.isArray(d.state.transactions)) {
    state = { ...blankState(), ...d.state, settings: { ...blankState().settings, ...(d.state.settings || {}) } };
    stateVersion = d.version || 0;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* cache only */ }
    hydrateSettings();
    renderAll();
    setCloudStatus('synced', `Reloaded the newer shared copy (v${stateVersion})`);
  }
  toast('This dashboard changed on another device — reloaded the latest version', 'warn');
  // single call site — every CRUD path in the app already funnels through
  // save(), so this is the one place Sheets sync can't be missed
  scheduleSheetsSync();
}

/* ── money & dates ─────────────────────────────────────── */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND']);

function fmtMoney(n, { compact = false, sign = false } = {}) {
  const cur = state.settings.currency || 'USD';
  const abs = Math.abs(n);
  const opts = {
    style: 'currency', currency: cur,
    maximumFractionDigits: ZERO_DECIMAL.has(cur) ? 0 : (compact || abs >= 1000 ? 0 : 2),
    minimumFractionDigits: 0,
  };
  if (compact && abs >= 10000) { opts.notation = 'compact'; opts.maximumFractionDigits = 1; }
  let out;
  try { out = new Intl.NumberFormat(undefined, opts).format(abs); }
  catch { out = abs.toFixed(0); }
  const prefix = n < 0 ? '−' : (sign && n > 0 ? '+' : '');
  return prefix + out;
}

function currencySymbol() {
  const cur = state.settings.currency || 'USD';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 0 })
      .formatToParts(0).find((p) => p.type === 'currency')?.value || '$';
  } catch { return '$'; }
}

const fmtDate = (iso) => {
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};
const monthKey = (iso) => String(iso).slice(0, 7);
const monthLabel = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short' });
};
const monthLabelFull = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
};

const RANGE_LABELS = {
  all: 'All time', '12m': 'Last 12 months', '6m': 'Last 6 months',
  '90d': 'Last 90 days', '30d': 'Last 30 days', '7d': 'Last 7 days',
};
/** Ranges you can step backwards and forwards through, one period at a
 *  time. Everything else is a rolling window anchored to today. */
const PERIOD_KINDS = { day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year' };
const isPeriodKind = (r) => Object.prototype.hasOwnProperty.call(PERIOD_KINDS, r);

function startOfWeek(date) {          // weeks run Monday → Sunday
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/** Bounds for a steppable period. offset 0 = the current one, -1 the
 *  one before it, and so on. */
function periodBounds(kind, offset = 0) {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  let s, e;
  switch (kind) {
    case 'day':
      s = new Date(now); s.setDate(s.getDate() + offset); e = new Date(s); break;
    case 'week':
      s = startOfWeek(now); s.setDate(s.getDate() + offset * 7);
      e = new Date(s); e.setDate(e.getDate() + 6); break;
    case 'quarter': {
      const q = Math.floor(now.getMonth() / 3) + offset;
      s = new Date(now.getFullYear(), q * 3, 1);
      e = new Date(now.getFullYear(), q * 3 + 3, 0); break;
    }
    case 'year':
      s = new Date(now.getFullYear() + offset, 0, 1);
      e = new Date(now.getFullYear() + offset, 11, 31); break;
    case 'month':
    default:
      s = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      e = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0); break;
  }
  return { start: isoLocal(s), end: isoLocal(e) };
}

function periodLabel(kind, offset = 0) {
  const { start, end } = periodBounds(kind, offset);
  const s = new Date(start + 'T00:00:00'), e = new Date(end + 'T00:00:00');
  const L = (d, o) => d.toLocaleDateString(undefined, o);
  switch (kind) {
    case 'day':
      if (offset === 0) return 'Today';
      if (offset === -1) return 'Yesterday';
      return L(s, { day: 'numeric', month: 'short', year: 'numeric' });
    case 'week': {
      if (offset === 0) return 'This week';
      if (offset === -1) return 'Last week';
      const head = s.getMonth() === e.getMonth() ? `${s.getDate()}` : `${s.getDate()} ${L(s, { month: 'short' })}`;
      return `${head} – ${e.getDate()} ${L(e, { month: 'short', year: 'numeric' })}`;
    }
    case 'quarter': return `Q${Math.floor(s.getMonth() / 3) + 1} ${s.getFullYear()}`;
    case 'year':    return String(s.getFullYear());
    case 'month':
    default:        return L(s, { month: 'long', year: 'numeric' });
  }
}

function customRangeLabel() {
  if (!ui.customStart || !ui.customEnd) return 'Custom range';
  return ui.customStart === ui.customEnd ? fmtDate(ui.customStart) : `${fmtDate(ui.customStart)} – ${fmtDate(ui.customEnd)}`;
}

/** One label for whatever the current selection is, used by the topbar
 *  and the hero pill so they can never disagree. */
function currentRangeLabel() {
  if (ui.range === 'custom') return customRangeLabel();
  if (isPeriodKind(ui.range)) return periodLabel(ui.range, ui.periodOffset);
  return RANGE_LABELS[ui.range] || 'Last 12 months';
}

/** Returns {start, end} as ISO date strings; start is null for "all". */
function rangeBounds(range = ui.range, offset = ui.periodOffset) {
  if (isPeriodKind(range)) return periodBounds(range, offset);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const end = isoLocal(now);
  const back = (days) => { const d = new Date(now); d.setDate(d.getDate() - days + 1); return isoLocal(d); };
  const backMonths = (m) => isoLocal(new Date(now.getFullYear(), now.getMonth() - m + 1, 1));
  switch (range) {
    case 'all': return { start: null, end: null };
    case 'custom': return { start: ui.customStart || end, end: ui.customEnd || end };
    case '7d':  return { start: back(7), end };
    case '30d': return { start: back(30), end };
    case '90d': return { start: back(90), end };
    case '6m':  return { start: backMonths(6), end };
    case '12m':
    default:    return { start: backMonths(12), end };
  }
}

/** The comparable window immediately before the current one. For
 *  stepped periods that's simply the previous period (so February is
 *  compared against January, not "the 28 days before February"). */
function previousBounds() {
  if (isPeriodKind(ui.range)) return periodBounds(ui.range, ui.periodOffset - 1);
  const { start, end } = rangeBounds();
  if (!start) return null;
  const s = new Date(start + 'T00:00:00'), e = new Date(end + 'T00:00:00');
  const span = Math.max(1, Math.round((e - s) / 86400000) + 1);
  const pe = new Date(s); pe.setDate(pe.getDate() - 1);
  const ps = new Date(pe); ps.setDate(ps.getDate() - span + 1);
  return { start: isoLocal(ps), end: isoLocal(pe) };
}

function inRange(tx, bounds) {
  if (!bounds || !bounds.start) return true;
  return tx.date >= bounds.start && tx.date <= bounds.end;
}

const txInRange = (bounds = rangeBounds()) => state.transactions.filter((t) => inRange(t, bounds));

/* ── lookups ───────────────────────────────────────────── */
const catById  = (id) => state.categories.find((c) => c.id === id);
const projById = (id) => state.projects.find((p) => p.id === id);
const catName  = (id) => catById(id)?.name || 'Uncategorised';
const projName = (id) => projById(id)?.name || null;

const FREQ_LABEL = { monthly: '/month', annual: '/year', biweekly: '/2 weeks', weekly: '/week', hourly: '/hour', daily: '/day' };
const FREQ_SELECT_LABEL = {
  monthly: 'Fixed — Monthly', annual: 'Fixed — Per year', biweekly: 'Fixed — Every 2 weeks', weekly: 'Fixed — Weekly',
  hourly: 'Hourly', daily: 'Daily', projectBased: 'Project based', variableMonthly: 'Variable monthly', freelance: 'Freelance',
};
const FREQ_TO_MONTHLY = { monthly: 1, annual: 1 / 12, biweekly: 26 / 12, weekly: 52 / 12, hourly: 160, daily: 22 };
// non-recurring structures: no fixed amount, so the payroll modal always asks for a per-payment figure
const VARIABLE_FREQUENCIES = new Set(['variableMonthly', 'projectBased', 'freelance']);
const isVariableSalary = (e) => VARIABLE_FREQUENCIES.has(e.frequency);
const monthlyCost = (emp) => isVariableSalary(emp) ? 0 : (Number(emp.salary) || 0) * (FREQ_TO_MONTHLY[emp.frequency] ?? 1);
const isActiveEmp = (e) => e.status === 'Active' || e.status === 'Contract' || e.status === 'On leave';

const SUB_CYCLE_TO_MONTHLY = { monthly: 1, yearly: 1 / 12 };
const monthlySubCost = (s) => (Number(s.amount) || 0) * (SUB_CYCLE_TO_MONTHLY[s.billingCycle] ?? 1);
const isActiveSub = (s) => s.status === 'Active';

/** Posts one expense transaction per elapsed billing period for every active
 *  subscription, then advances renewalDate past today — same "generate the
 *  ledger row, don't just add a virtual total" approach as payroll runs. */
function advanceSubscriptions() {
  let changed = false;
  const today = todayISO();
  for (const s of state.subscriptions) {
    if (s.status !== 'Active' || !s.renewalDate) continue;
    let guard = 0;
    while (s.renewalDate <= today && guard++ < 60) {
      let subCat = state.categories.find((c) => c.type === 'expense' && /subscri/i.test(c.name));
      if (!subCat) { subCat = { id: uid(), name: 'Subscriptions', type: 'expense' }; state.categories.push(subCat); }
      state.transactions.push({
        id: uid(), created: Date.now(), type: 'expense', amount: Number(s.amount) || 0,
        date: s.renewalDate, category: subCat.id, project: s.project || '',
        description: `${s.platform} subscription`, method: s.paymentMethod || '',
        reference: '', subscriptionId: s.id,
      });
      const d = new Date(s.renewalDate + 'T00:00:00');
      if (s.billingCycle === 'yearly') d.setFullYear(d.getFullYear() + 1);
      else d.setMonth(d.getMonth() + 1);
      s.renewalDate = d.toISOString().slice(0, 10);
      changed = true;
    }
  }
  if (changed) save();
}

/* ── totals ────────────────────────────────────────────── */
function totals(list) {
  const income  = sum(list.filter((t) => t.type === 'income'),  (t) => Number(t.amount) || 0);
  const expense = sum(list.filter((t) => t.type === 'expense'), (t) => Number(t.amount) || 0);
  return { income, expense, net: income - expense, margin: income ? (income - expense) / income : null };
}

/** Month buckets covering the active range (or the data's own span).
 *  Pass bounds explicitly (e.g. {start:null,end:null}) for a full-history
 *  series that ignores the topbar's date filter — used by detail pages. */
function monthlySeries(list, bounds = rangeBounds()) {
  const { start, end } = bounds;
  let from, to;
  if (start) { from = start.slice(0, 7); to = end.slice(0, 7); }
  else if (list.length) {
    const keys = list.map((t) => monthKey(t.date)).sort();
    from = keys[0]; to = keys[keys.length - 1];
  } else {
    from = to = todayISO().slice(0, 7);
  }
  const buckets = new Map();
  let [y, m] = from.split('-').map(Number);
  const [ey, em] = to.split('-').map(Number);
  let guard = 0;
  while ((y < ey || (y === ey && m <= em)) && guard++ < 240) {
    buckets.set(`${y}-${String(m).padStart(2, '0')}`, { key: `${y}-${String(m).padStart(2, '0')}`, income: 0, expense: 0 });
    m++; if (m > 12) { m = 1; y++; }
  }
  for (const t of list) {
    const b = buckets.get(monthKey(t.date));
    if (b) b[t.type] += Number(t.amount) || 0;
  }
  return [...buckets.values()].map((b) => ({ ...b, net: b.income - b.expense }));
}

/* ═══════════════════════════════════════════════════════
   Charts — hand-built SVG.
   money in = blue, money out = red (validated diverging pair)
   ═══════════════════════════════════════════════════════ */
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Rounded data-end at the top, square at the baseline. */
function columnPath(x, y, w, h, r = 4) {
  const rr = Math.min(r, w / 2, Math.max(0, h));
  if (h <= 0.5) return '';
  return `M${x},${y + h}L${x},${y + rr}Q${x},${y} ${x + rr},${y}L${x + w - rr},${y}Q${x + w},${y} ${x + w},${y + rr}L${x + w},${y + h}Z`;
}
/** Rounded data-end at the right, square at the baseline. */
function rowPath(x, y, w, h, r = 4) {
  const rr = Math.min(r, h / 2, Math.max(0, w));
  if (w <= 0.5) return '';
  return `M${x},${y}L${x + w - rr},${y}Q${x + w},${y} ${x + w},${y + rr}L${x + w},${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}L${x},${y + h}Z`;
}

function niceTicks(max, count = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

const compactAxis = (n) => {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a % 1e9 ? 1 : 0) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(a % 1e6 ? 1 : 0) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a % 1e3 ? 1 : 0) + 'K';
  return String(Math.round(n));
};

/** Cubic-Bézier curve through a series of [x,y] points (Catmull-Rom
 *  style tangents) — smooth premium curves instead of straight polyline
 *  segments, used by every trend-line chart. */
function smoothPath(pts) {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/** Sets up the "draw itself on" stroke animation — measures the real
 *  path length after insertion rather than guessing a fixed value, so it
 *  works at any chart size. */
function animateLineDraw(pathEl) {
  const len = pathEl.getTotalLength();
  pathEl.style.setProperty('--len', len);
  pathEl.style.strokeDasharray = String(len);
}

let gradientUid = 0;
/** Returns {id, html} for a vertical fade-to-transparent gradient —
 *  built as a string (not appendChild) because callers assemble their
 *  whole chart as one HTML string before a single innerHTML write. */
function fadeGradientDef(color) {
  const id = `grad${++gradientUid}`;
  const html = `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="${color}" stop-opacity="0.32"/>` +
    `<stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient>`;
  return { id, html };
}

/** A subtle top-to-bottom two-stop gradient (same hue, slightly deeper
 *  at the base) so bars read as premium rather than flat-filled. */
function barGradientDef(color) {
  const id = `grad${++gradientUid}`;
  const html = `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="${color}" stop-opacity="1"/>` +
    `<stop offset="100%" stop-color="${color}" stop-opacity=".72"/></linearGradient>`;
  return { id, html };
}

/* ── cash-flow columns ─────────────────────────────────── */
function drawFlowChart() {
  const host = $('#flowHost');
  const data = monthlySeries(txInRange());

  if (!data.length || !data.some((d) => d.income || d.expense)) {
    host.onpointermove = host.onpointerleave = null;
    host.innerHTML = emptyBlock('No entries in this period', 'Add an entry or widen the date range to see cash flow.', '', 'ledger');
    $('#flowTable').innerHTML = '';
    return;
  }

  // rebuild the host each pass so it recovers cleanly from the empty state
  host.innerHTML = `<svg id="flowChart" role="img" aria-label="Grouped columns comparing money in and money out for each month"></svg><div class="tooltip" id="flowTip" role="status" aria-live="polite"></div>`;
  const svg = $('#flowChart', host);
  const tip = $('#flowTip', host);
  const W = host.clientWidth || 600;
  const H = host.clientHeight || 260;

  const pad = { t: 12, r: 8, b: 26, l: 44 };
  const iw = Math.max(40, W - pad.l - pad.r);
  const ih = Math.max(40, H - pad.t - pad.b);
  const max = Math.max(...data.map((d) => Math.max(d.income, d.expense)), 1);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const yOf = (v) => pad.t + ih - (v / top) * ih;

  const band = iw / data.length;
  const GAP = 2;                                   // the surface gap between paired bars
  const barW = clamp((band - 16 - GAP) / 2, 3, 24); // bars capped at 24px, never fill the band
  const groupW = barW * 2 + GAP;

  const inGrad = barGradientDef('var(--flow-in)');
  const outGrad = barGradientDef('var(--flow-out)');
  let g = `<defs>${inGrad.html}${outGrad.html}</defs>`;
  ticks.forEach((t) => {
    const y = yOf(t);
    g += `<line class="grid-line" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${(pad.l + iw).toFixed(1)}" y2="${y.toFixed(1)}"/>`;
    g += `<text class="axis-text" x="${pad.l - 9}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${compactAxis(t)}</text>`;
  });
  g += `<line class="axis-line" x1="${pad.l}" y1="${(pad.t + ih).toFixed(1)}" x2="${(pad.l + iw).toFixed(1)}" y2="${(pad.t + ih).toFixed(1)}"/>`;

  const showEvery = Math.ceil(data.length / (iw / 46));
  data.forEach((d, i) => {
    const cx = pad.l + band * i + band / 2;
    const x0 = cx - groupW / 2;
    const hIn  = (d.income / top) * ih;
    const hOut = (d.expense / top) * ih;
    const delay = `style="animation-delay:${Math.min(i * 25, 400)}ms"`;
    g += `<rect class="hover-band" data-i="${i}" x="${(pad.l + band * i).toFixed(1)}" y="${pad.t}" width="${band.toFixed(1)}" height="${ih}" rx="6"/>`;
    g += `<path class="bar bar-v" data-i="${i}" ${delay} d="${columnPath(x0, yOf(d.income), barW, hIn)}" fill="url(#${inGrad.id})"/>`;
    g += `<path class="bar bar-v" data-i="${i}" ${delay} d="${columnPath(x0 + barW + GAP, yOf(d.expense), barW, hOut)}" fill="url(#${outGrad.id})"/>`;
    if (i % showEvery === 0 || i === data.length - 1) {
      g += `<text class="axis-text" x="${cx.toFixed(1)}" y="${(pad.t + ih + 17).toFixed(1)}" text-anchor="middle">${monthLabel(d.key)}</text>`;
    }
  });

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = g;

  // hover layer: one band per month, crosshair-style
  const bands = $$('.hover-band', svg);
  const bars = $$('.bar', svg);
  const onMove = (ev) => {
    const rect = host.getBoundingClientRect();
    const i = clamp(Math.floor(((ev.clientX - rect.left) - pad.l) / band), 0, data.length - 1);
    if (ev.clientX - rect.left < pad.l) { onLeave(); return; }
    const d = data[i];
    bands.forEach((b, j) => b.classList.toggle('is-on', j === i));
    bars.forEach((b) => b.classList.toggle('is-hot', +b.dataset.i === i));
    host.classList.add('is-hovering');
    tip.innerHTML =
      `<h4>${monthLabelFull(d.key)}</h4>` +
      row('key-in', 'Money in', fmtMoney(d.income)) +
      row('key-out', 'Money out', fmtMoney(d.expense)) +
      `<div class="tooltip-sep"></div>` +
      `<div class="tooltip-row"><span>Net</span><b class="${d.net < 0 ? 'is-negative' : ''}">${fmtMoney(d.net, { sign: true })}</b></div>`;
    tip.classList.add('is-on');
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const cx = pad.l + band * i + band / 2;
    tip.style.left = `${clamp(cx - tw / 2, 4, W - tw - 4)}px`;
    tip.style.top = `${clamp(yOf(Math.max(d.income, d.expense)) - th - 10, 4, H - th - 4)}px`;
  };
  const onLeave = () => {
    bands.forEach((b) => b.classList.remove('is-on'));
    host.classList.remove('is-hovering');
    tip.classList.remove('is-on');
  };
  host.onpointermove = onMove;
  host.onpointerleave = onLeave;

  function row(key, label, val) {
    return `<div class="tooltip-row"><i class="key ${key}"></i><span>${label}</span><b>${val}</b></div>`;
  }

  // table view — every value stays reachable without colour
  $('#flowTable').innerHTML =
    `<thead><tr><th>Month</th><th class="num">Money in</th><th class="num">Money out</th><th class="num">Net</th></tr></thead><tbody>` +
    data.map((d) => `<tr><td>${monthLabelFull(d.key)}</td><td class="num">${fmtMoney(d.income)}</td><td class="num">${fmtMoney(d.expense)}</td><td class="num ${d.net < 0 ? 'is-negative' : ''}">${fmtMoney(d.net, { sign: true })}</td></tr>`).join('') +
    `</tbody>`;
}

/* ── category ranking bars ─────────────────────────────── */
/** "Where money goes" — gradient bar rows. Replaces the old SVG
 *  ranking chart: same data and same top-6-plus-Other capping, but
 *  rendered as HTML rows so labels, amounts and share percentages can
 *  sit on a proper grid instead of being positioned by hand. */
const SPEND_HUES = ['var(--flow-in)', 'var(--good-text)', 'var(--flow-out)', '#a78bfa', '#f0b429', '#2dd4bf'];
const SPEND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12 12 20a1.5 1.5 0 0 1-2.1 0l-6-6a1.5 1.5 0 0 1 0-2.1L11.9 4H19a1 1 0 0 1 1 1v7z"/><circle cx="14.5" cy="8.5" r="1.4"/></svg>';

function drawCategoryChart() {
  const host = $('#catHost');
  if (!host) return;
  const dir = ui.breakdownDir;
  const base = txInRange().filter((t) => !ui.breakdownProject || t.project === ui.breakdownProject);
  const list = base.filter((t) => t.type === dir);

  const statsHost = $('#breakdownStats');
  if (ui.breakdownProject) {
    const bt = totals(base);
    statsHost.style.display = 'grid';
    statsHost.innerHTML =
      `<div class="proj-stat"><span>Money in</span><b>${fmtMoney(bt.income, { compact: true })}</b></div>` +
      `<div class="proj-stat"><span>Money out</span><b>${fmtMoney(bt.expense, { compact: true })}</b></div>` +
      `<div class="proj-stat"><span>Net profit</span><b class="${bt.net < 0 ? 'is-negative' : ''}">${fmtMoney(bt.net, { compact: true, sign: true })}</b></div>`;
  } else {
    statsHost.style.display = 'none';
    statsHost.innerHTML = '';
  }

  const byCat = new Map();
  for (const t of list) {
    const name = catName(t.category);
    byCat.set(name, (byCat.get(name) || 0) + (Number(t.amount) || 0));
  }
  let rows = [...byCat.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);

  if (!rows.length) {
    host.innerHTML = emptyBlock('Nothing to break down', `No ${dir === 'expense' ? 'costs' : 'income'} recorded in this period.`, '', 'tag');
    $('#catTable').innerHTML = '';
    return;
  }
  if (rows.length > 6) {
    const head = rows.slice(0, 5);
    rows = [...head, { name: 'Other expenses', value: sum(rows.slice(5), (r) => r.value), isOther: true }];
  }

  const max = Math.max(...rows.map((r) => r.value), 1);
  const total = sum(rows, (r) => r.value);

  host.innerHTML = rows.map((r, i) => {
    const hue = r.isOther ? 'var(--ink-muted)' : SPEND_HUES[i % SPEND_HUES.length];
    const w = Math.max((r.value / max) * 100, 2);
    const pct = total ? (r.value / total) * 100 : 0;
    return `<div class="spend-row" style="--bar-hue:${hue}" title="${esc(r.name)} — ${fmtMoney(r.value)} (${pct.toFixed(1)}%)">
      <span class="spend-chip">${SPEND_ICON}</span>
      <span class="spend-name">${esc(r.name)}</span>
      <span class="spend-track"><span class="spend-fill" style="width:${w.toFixed(1)}%;animation-delay:${i * 70}ms"></span></span>
      <span class="spend-amt">${fmtMoney(r.value, { compact: true })}</span>
      <span class="spend-pct">${pct.toFixed(0)}%</span>
    </div>`;
  }).join('');

  $('#catTable').innerHTML =
    `<thead><tr><th>Category</th><th class="num">Total</th><th class="num">Share</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${fmtMoney(r.value)}</td><td class="num">${total ? ((r.value / total) * 100).toFixed(1) : '0.0'}%</td></tr>`).join('') +
    `</tbody>`;
}

/* ── hero sparkline (single series → no legend) ────────── */
function drawSparkline() {
  const svg = $('#heroSpark');
  const data = monthlySeries(txInRange());
  const W = 320, H = 64;
  if (data.length < 2) { svg.innerHTML = ''; return; }

  const vals = data.map((d) => d.net);
  const lo = Math.min(...vals, 0), hi = Math.max(...vals, 0);
  const span = (hi - lo) || 1;
  const x = (i) => (i / (data.length - 1)) * (W - 6) + 3;
  const y = (v) => H - 6 - ((v - lo) / span) * (H - 12);

  const pts = vals.map((v, i) => [x(i), y(v)]);
  const line = smoothPath(pts);
  const area = `${line}L${x(data.length - 1).toFixed(1)},${y(lo).toFixed(1)}L${x(0).toFixed(1)},${y(lo).toFixed(1)}Z`;
  const last = vals[vals.length - 1];
  const stroke = last < 0 ? 'var(--flow-out)' : 'var(--flow-in)';
  const zeroY = y(0);
  const grad = fadeGradientDef(stroke);

  svg.innerHTML =
    `<defs>${grad.html}</defs>` +
    `<path class="trend-area" d="${area}" fill="url(#${grad.id})"/>` +
    (lo < 0 ? `<line class="grid-line" x1="3" y1="${zeroY.toFixed(1)}" x2="${W - 3}" y2="${zeroY.toFixed(1)}"/>` : '') +
    `<path class="trend-line" id="sparkLine" d="${line}" fill="none" stroke="${stroke}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` +
    `<circle cx="${x(data.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="4.5" fill="${stroke}" stroke="var(--surface)" stroke-width="2"/>`;
  animateLineDraw($('#sparkLine', svg));
}

const EMPTY_ICONS = {
  generic: '<path d="M4 18l5-6 4 3.5L20 7"/><path d="M4 20h16"/>',
  ledger:  '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  folder:  '<path d="M4 7a2 2 0 0 1 2-2h4l2 2.5h6a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7z"/>',
  people:  '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 6.2a3 3 0 0 1 0 5.6"/><path d="M17.5 19a5.6 5.6 0 0 0-2-4"/>',
  cards:   '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>',
  tag:     '<path d="M20 12 12 20a1.5 1.5 0 0 1-2.1 0l-6-6a1.5 1.5 0 0 1 0-2.1L11.9 4H19a1 1 0 0 1 1 1v7z"/><circle cx="14.5" cy="8.5" r="1.5"/>',
};

/** Small smoothed line + fade for the KPI tiles. `key` picks which
 *  series the tile is showing; colour comes from the tile's own hue. */
function drawTileSpark(svgId, values, color) {
  const svg = $(svgId);
  if (!svg) return;
  const W = 120, H = 44;
  const vals = values.length >= 2 ? values : [0, 0];
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = (hi - lo) || 1;
  const x = (i) => (i / (vals.length - 1)) * (W - 4) + 2;
  const y = (v) => H - 5 - ((v - lo) / span) * (H - 12);
  const pts = vals.map((v, i) => [x(i), y(v)]);
  const line = smoothPath(pts);
  const area = `${line}L${W - 2},${H}L2,${H}Z`;
  const gid = `tsp${++gradientUid}`;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML =
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="${color}" stop-opacity=".38"/>` +
    `<stop offset="100%" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>` +
    `<path d="${area}" fill="url(#${gid})"/>` +
    `<path d="${line}" fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` +
    `<circle cx="${x(vals.length - 1).toFixed(1)}" cy="${y(vals[vals.length - 1]).toFixed(1)}" r="2.6" fill="${color}"/>`;
}

function emptyBlock(title, text, action = '', icon = 'generic') {
  const paths = EMPTY_ICONS[icon] || EMPTY_ICONS.generic;
  return `<div class="empty">
    <span class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg></span>
    <b>${esc(title)}</b><p>${esc(text)}</p>${action}</div>`;
}

/* ═══════════════════════════════════════════════════════
   Custom dropdown — progressive enhancement over <select>.
   The native <select> stays in the DOM (hidden) as the single source
   of truth: every existing .value read/write and 'change' listener
   elsewhere in this file keeps working completely unmodified. This
   only replaces how the control is *drawn* and *opened*, because no
   browser gives CSS control over a native <select>'s popup (hover
   states, accent colours, open/close animation are all impossible
   there regardless of color-scheme).
   ═══════════════════════════════════════════════════════ */
function enhanceSelect(select) {
  if (!select || select.dataset.enhanced) return;
  select.dataset.enhanced = '1';
  select.classList.add('csel-native');

  const wrap = document.createElement('span');
  wrap.className = 'csel';
  const wrapId = `csel-${uid()}`;
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'csel-trigger';
  if (select.id) trigger.dataset.for = select.id;
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = '<span class="csel-label"></span>' +
    '<svg class="csel-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  wrap.appendChild(trigger);

  const panel = document.createElement('ul');
  panel.className = 'csel-panel';
  panel.setAttribute('role', 'listbox');
  panel.tabIndex = -1;
  panel.hidden = true;
  wrap.appendChild(panel);

  let activeIndex = -1;

  const syncLabel = () => {
    trigger.disabled = select.disabled;
    trigger.classList.toggle('is-disabled', select.disabled);
    const opt = select.selectedOptions[0];
    trigger.querySelector('.csel-label').textContent = opt ? opt.textContent : '';
  };

  const closePanel = (focusTrigger) => {
    if (panel.hidden) return;
    panel.hidden = true;
    wrap.classList.remove('is-open');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    if (focusTrigger) trigger.focus();
    document.removeEventListener('pointerdown', onDocPointerDown, true);
  };

  // panel is portalled to <body> while open, so it is no longer inside wrap
  const onDocPointerDown = (e) => {
    if (!wrap.contains(e.target) && !panel.contains(e.target)) closePanel(false);
  };

  const buildOptions = () => {
    let html = '', i = 0;
    for (const node of select.children) {
      if (node.tagName === 'OPTGROUP') {
        html += `<li class="csel-group" role="presentation">${esc(node.label)}</li>`;
        for (const opt of node.children) { html += optionHtml(opt, i); i++; }
      } else if (node.tagName === 'OPTION') {
        html += optionHtml(node, i); i++;
      }
    }
    panel.innerHTML = html;
    activeIndex = [...select.options].findIndex((o) => o.selected);
    if (activeIndex < 0) activeIndex = 0;
  };
  function optionHtml(o, i) {
    return `<li role="option" id="${wrapId}-opt-${i}" data-i="${i}" class="csel-option${o.selected ? ' is-selected' : ''}"${o.disabled ? ' aria-disabled="true"' : ''}>${esc(o.textContent)}</li>`;
  }

  const items = () => $$('.csel-option', panel);

  const highlight = (i) => {
    items().forEach((el, idx) => el.classList.toggle('is-active', idx === i));
    const el = items()[i];
    if (el) { trigger.setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' }); }
  };

  const openPanel = () => {
    if (select.disabled) return;
    buildOptions();
    // Where the panel gets portalled matters twice over:
    //  * position:fixed resolves against the nearest ancestor carrying a
    //    transform / filter / will-change, not the viewport — and cards
    //    have a hover transform, so a panel left inside one anchors to
    //    the card.
    //  * showModal() puts a <dialog> in the top layer, which paints above
    //    the whole normal stacking context. A panel parked on <body>
    //    while a modal is open is therefore invisible behind it, and no
    //    z-index can lift it out.
    // So: into the open dialog when there is one (same top layer, and
    // .modal[open] is transform:none so it makes no containing block),
    // otherwise onto <body>.
    const portalHost = select.closest('dialog[open]') || document.body;
    if (panel.parentElement !== portalHost) portalHost.appendChild(panel);
    const r = trigger.getBoundingClientRect(); // wrap is display:contents — has no box of its own
    const spaceBelow = window.innerHeight - r.bottom;
    const spaceAbove = r.top;
    const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    panel.style.left = `${Math.max(8, r.left)}px`;
    panel.style.width = `${Math.max(r.width, 180)}px`;
    panel.style.maxHeight = `${Math.max(120, (openUp ? spaceAbove : spaceBelow) - 16)}px`;
    panel.classList.toggle('csel-panel--up', openUp);
    if (openUp) { panel.style.top = ''; panel.style.bottom = `${window.innerHeight - r.top + 6}px`; }
    else { panel.style.bottom = ''; panel.style.top = `${r.bottom + 6}px`; }
    panel.hidden = false;
    wrap.classList.add('is-open');
    trigger.setAttribute('aria-expanded', 'true');
    highlight(activeIndex);
    panel.focus();
    document.addEventListener('pointerdown', onDocPointerDown, true);
  };

  const choose = (i) => {
    const opt = select.options[i];
    if (!opt || opt.disabled) return;
    select.value = opt.value;
    syncLabel();
    select.dispatchEvent(new Event('change', { bubbles: true }));
    closePanel(true);
  };

  trigger.addEventListener('click', () => { panel.hidden ? openPanel() : closePanel(true); });
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (panel.hidden) openPanel();
    }
  });

  panel.addEventListener('keydown', (e) => {
    const list = items();
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(list.length - 1, activeIndex + 1); highlight(activeIndex); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(0, activeIndex - 1); highlight(activeIndex); }
    else if (e.key === 'Home') { e.preventDefault(); activeIndex = 0; highlight(activeIndex); }
    else if (e.key === 'End') { e.preventDefault(); activeIndex = list.length - 1; highlight(activeIndex); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(activeIndex); }
    else if (e.key === 'Escape') { e.preventDefault(); closePanel(true); }
    else if (e.key === 'Tab') { closePanel(false); }
    else if (e.key.length === 1) {
      const start = (activeIndex + 1) % list.length;
      for (let k = 0; k < list.length; k++) {
        const idx = (start + k) % list.length;
        if (list[idx].textContent.trim().toLowerCase().startsWith(e.key.toLowerCase())) { activeIndex = idx; highlight(idx); break; }
      }
    }
  });

  panel.addEventListener('click', (e) => {
    const li = e.target.closest('.csel-option');
    if (li) choose(Number(li.dataset.i));
  });
  panel.addEventListener('pointermove', (e) => {
    const li = e.target.closest('.csel-option');
    if (li) { const i = Number(li.dataset.i); if (i !== activeIndex) { activeIndex = i; highlight(activeIndex); } }
  });

  select._syncLabel = syncLabel;
  syncLabel();
}

function enhanceAllSelects(root = document) { $$('select', root).forEach(enhanceSelect); }
function syncSelectLabels(root = document) { $$('select[data-enhanced]', root).forEach((s) => s._syncLabel && s._syncLabel()); }

/* ═══════════════════════════════════════════════════════
   Views
   ═══════════════════════════════════════════════════════ */
function renderAll() {
  $('#brandCompany').textContent = state.settings.company || 'My Company';
  $('#navCountTx').textContent = state.transactions.length;
  $('#navCountProj').textContent = state.projects.length;
  $('#navCountEmp').textContent = state.employees.length;
  $$('.cur-sym, #txCurSym').forEach((n) => (n.textContent = currencySymbol()));

  renderSidebarStat();
  renderOverview();
  renderTransactions();
  renderProjects();
  renderEmployees();
  renderSubscriptions();
  renderCategories();
  renderPaymentMethods();
  refreshSelects();
  renderStorageHint();
  if (ui.detailEmployeeId) renderEmployeeDetail();
  if (ui.detailProjectId) renderProjectDetail();
  syncSelectLabels();
  refreshReorderables();   // project grid is rebuilt each render — rewire its handles
}

function renderStorageHint() {
  const bytes = new Blob([JSON.stringify(state)]).size;
  $('#storageHint').textContent =
    `${state.transactions.length} entries · ${state.projects.length} projects · ${state.employees.length} employees · ${(bytes / 1024).toFixed(1)} KB stored locally.`;
}

function renderSidebarStat() {
  const t = totals(txInRange());
  $('#sideNet').textContent = fmtMoney(t.net, { compact: true });
  $('#sideNet').classList.toggle('is-negative', t.net < 0);
  const denom = t.income + t.expense;
  $('#sideBar').style.width = `${denom ? (t.income / denom) * 100 : 50}%`;
  $('#sideSub').textContent = denom
    ? `${fmtMoney(t.income, { compact: true })} in · ${fmtMoney(t.expense, { compact: true })} out`
    : 'No entries yet';
}

/* ── overview ──────────────────────────────────────────── */
function renderOverview() {
  const list = txInRange();
  const t = totals(list);

  $('#heroRangeLabel').textContent = currentRangeLabel();
  const hero = $('#heroNet');
  animateCount(hero, t.net, (v) => fmtMoney(v));
  hero.classList.toggle('is-negative', t.net < 0);
  renderMotivation(t, list);

  // delta vs the previous equal-length window
  const prevB = previousBounds();
  const deltaEl = $('#heroDelta');
  const iconEl = $('.delta-icon', deltaEl);
  const textEl = $('.delta-text', deltaEl);
  deltaEl.classList.remove('is-up', 'is-down');
  if (prevB) {
    const prev = totals(txInRange(prevB));
    if (prev.net === 0 && t.net === 0) {
      textEl.textContent = 'No change'; iconEl.hidden = true;
      $('#heroDeltaSub').textContent = 'vs previous period';
    } else if (prev.net === 0) {
      textEl.textContent = 'New'; iconEl.hidden = true;
      $('#heroDeltaSub').textContent = 'no prior activity';
    } else {
      const pct = ((t.net - prev.net) / Math.abs(prev.net)) * 100;
      const up = t.net >= prev.net;
      iconEl.hidden = false;
      deltaEl.classList.add(up ? 'is-up' : 'is-down');
      textEl.textContent = `${Math.abs(pct).toFixed(pct >= 100 ? 0 : 1)}%`;
      $('#heroDeltaSub').textContent = `vs ${fmtMoney(prev.net)} previous period`;
    }
  } else {
    textEl.textContent = `${list.length} entries`; iconEl.hidden = true;
    $('#heroDeltaSub').textContent = 'across all time';
  }

  animateCount($('#tileIn'), t.income, (v) => fmtMoney(v, { compact: true }));
  animateCount($('#tileOut'), t.expense, (v) => fmtMoney(v, { compact: true }));
  $('#tileInSub').textContent = `${list.filter((x) => x.type === 'income').length} entries`;
  $('#tileOutSub').textContent = `${list.filter((x) => x.type === 'expense').length} entries`;
  $('#tileMargin').textContent = t.margin === null ? '—' : `${(t.margin * 100).toFixed(1)}%`;
  $('#tileMargin').classList.toggle('is-negative', t.margin !== null && t.margin < 0);

  const roster = state.employees.filter(isActiveEmp);
  const payrollMonthly = sum(roster, monthlyCost);
  animateCount($('#tilePayroll'), payrollMonthly, (v) => fmtMoney(v, { compact: true }));
  $('#tilePayrollSub').textContent = `${roster.length} ${roster.length === 1 ? 'person' : 'people'} · per month`;

  // per-tile mini trends, from the same monthly buckets the hero uses
  const series = monthlySeries(list);
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  drawTileSpark('#sparkIn', series.map((d) => d.income), css('--good-text'));
  drawTileSpark('#sparkOut', series.map((d) => d.expense), css('--flow-out'));
  drawTileSpark('#sparkMargin', series.map((d) => (d.income ? (d.income - d.expense) / d.income : 0)), css('--flow-in'));
  // real salary spend per month, not a scaled stand-in — a sparkline
  // that isn't the actual series is just a decorative lie
  const paySeries = monthlySeries(list.filter((t) => t.employee));
  drawTileSpark('#sparkPayroll', paySeries.map((d) => d.expense), '#a78bfa');

  drawSparkline();
  drawFlowChart();
  drawCategoryChart();
  renderProjectSummary(list);
  renderRecent();
}

function renderProjectSummary(list) {
  const rows = state.projects.map((p) => {
    const own = list.filter((t) => t.project === p.id);
    return { ...p, ...totals(own), count: own.length };
  }).sort((a, b) => b.net - a.net);

  const table = $('#projSummaryTable');
  if (!rows.length) {
    table.innerHTML = `<tbody><tr><td>${emptyBlock('No projects yet', 'Create a project to see profitability broken out per job.', '<button class="ghost-btn sm" data-goto="projects">Create a project</button>', 'folder')}</td></tr></tbody>`;
    return;
  }
  const peak = Math.max(...rows.map((r) => Math.abs(r.net)), 1);
  table.innerHTML =
    `<thead><tr><th>Project</th><th class="num">In</th><th class="num">Out</th><th class="num">Net</th><th>Margin</th></tr></thead><tbody>` +
    rows.map((r) => {
      const pct = r.margin === null ? null : r.margin * 100;
      const w = (Math.abs(r.net) / peak) * 100;
      return `<tr>
        <td><div class="cell-main"><b>${esc(r.name)}</b>${r.client ? `<small>${esc(r.client)}</small>` : ''}</div></td>
        <td class="num">${fmtMoney(r.income, { compact: true })}</td>
        <td class="num">${fmtMoney(r.expense, { compact: true })}</td>
        <td class="num ${r.net < 0 ? 'is-negative' : ''}">${fmtMoney(r.net, { compact: true, sign: true })}</td>
        <td><div class="cat-meter"><div class="mini-bar"><i style="width:${w.toFixed(0)}%;background:${r.net < 0 ? 'var(--flow-out)' : 'var(--flow-in)'}"></i></div><small>${pct === null ? '—' : pct.toFixed(0) + '%'}</small></div></td>
      </tr>`;
    }).join('') + `</tbody>`;
}

function renderRecent() {
  const feed = $('#recentFeed');
  const rows = [...state.transactions].sort((a, b) => (b.date.localeCompare(a.date)) || b.created - a.created).slice(0, 8);
  if (!rows.length) {
    feed.innerHTML = `<li>${emptyBlock('Nothing recorded yet', 'Your most recent money movements will appear here.', '<button class="primary-btn sm" id="feedAdd">Add first entry</button>', 'ledger')}</li>`;
    $('#feedAdd')?.addEventListener('click', () => openTx());
    return;
  }
  feed.innerHTML = rows.map((t) => {
    const inc = t.type === 'income';
    const proj = projName(t.project);
    return `<li>
      <span class="feed-icon feed-icon--${inc ? 'in' : 'out'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
          ${inc ? '<path d="M12 19V5M12 5l-5 5M12 5l5 5"/>' : '<path d="M12 5v14M12 19l5-5M12 19l-5-5"/>'}
        </svg>
      </span>
      <span class="feed-body">
        <b>${esc(t.description || catName(t.category))}</b>
        <small>${fmtDate(t.date)} · ${esc(catName(t.category))}${proj ? ' · ' + esc(proj) : ''}</small>
      </span>
      <span class="feed-amt ${inc ? 'amt-in' : 'amt-out'}">${inc ? '+' : '−'}${fmtMoney(Number(t.amount)).replace('−', '')}</span>
    </li>`;
  }).join('');
}

/* ── transactions ──────────────────────────────────────── */
function filteredTx() {
  const q = ui.txSearch.trim().toLowerCase();
  return txInRange().filter((t) => {
    if (ui.txType && t.type !== ui.txType) return false;
    if (ui.txCat && t.category !== ui.txCat) return false;
    if (ui.txProj && (t.project || '') !== ui.txProj) return false;
    if (!q) return true;
    return [t.description, catName(t.category), projName(t.project), t.method, t.reference]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
  });
}

function renderTransactions() {
  const rows = filteredTx();
  const { key, dir } = ui.txSort;
  const val = (t) => ({
    date: t.date, amount: Number(t.amount) || 0,
    category: catName(t.category), project: projName(t.project) || '',
    description: t.description || '', method: t.method || '', type: t.type,
  }[key]);
  rows.sort((a, b) => {
    const A = val(a), B = val(b);
    const c = typeof A === 'number' ? A - B : String(A).localeCompare(String(B));
    return c * dir || (b.created || 0) - (a.created || 0);
  });

  const table = $('#txTable');
  const cols = [
    ['date', 'Date', ''], ['description', 'Description', ''], ['category', 'Category', ''],
    ['project', 'Project', ''], ['method', 'Method', ''], ['amount', 'Amount', 'num'],
  ];
  const head = `<thead><tr>${cols.map(([k, label, cls]) =>
    `<th data-sort="${k}" class="${cls} ${key === k ? 'is-sorted' : ''}">${label}<span class="caret">${dir === 1 ? '▲' : '▼'}</span></th>`
  ).join('')}<th></th></tr></thead>`;

  if (!rows.length) {
    table.innerHTML = head + `<tbody><tr><td colspan="7">${emptyBlock(
      state.transactions.length ? 'No matching entries' : 'No transactions found',
      state.transactions.length ? 'Try clearing a filter or widening the date range.' : 'Record your first money movement to get started.',
      state.transactions.length ? '' : '<button class="primary-btn sm" id="txEmptyAdd">Add an entry</button>',
      'ledger'
    )}</td></tr></tbody>`;
    $('#txEmptyAdd')?.addEventListener('click', () => openTx());
    $('#txFoot').innerHTML = '';
    bindSort(table);
    return;
  }

  table.innerHTML = head + `<tbody>` + rows.map((t) => {
    const inc = t.type === 'income';
    const proj = projName(t.project);
    return `<tr data-id="${t.id}">
      <td style="white-space:nowrap">${fmtDate(t.date)}</td>
      <td><div class="cell-main"><b>${esc(t.description || '—')}</b>${t.reference ? `<small>${esc(t.reference)}</small>` : ''}</div></td>
      <td><span class="tag"><i style="color:${inc ? 'var(--flow-in)' : 'var(--flow-out)'}"></i>${esc(catName(t.category))}</span></td>
      <td>${proj ? `<span class="tag tag--muted">${esc(proj)}</span>` : '<span class="tag tag--muted">—</span>'}</td>
      <td style="color:var(--ink-muted)">${esc(t.method || '—')}</td>
      <td class="num ${inc ? 'amt-in' : 'amt-out'}">${inc ? '+' : '−'}${fmtMoney(Number(t.amount)).replace('−', '')}</td>
      <td><div class="row-actions">
        <button class="icon-btn" data-edit="${t.id}" aria-label="Edit entry"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg></button>
        <button class="icon-btn" data-del="${t.id}" aria-label="Delete entry"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M10 7V5h4v2M8 7l.7 12h6.6L16 7"/></svg></button>
      </div></td>
    </tr>`;
  }).join('') + `</tbody>`;

  const t = totals(rows);
  $('#txFoot').innerHTML = `<div class="foot-stats">
      <span>${rows.length} of ${state.transactions.length} entries</span>
      <span>In <strong>${fmtMoney(t.income)}</strong></span>
      <span>Out <strong>${fmtMoney(t.expense)}</strong></span>
    </div><span>Net <strong class="${t.net < 0 ? 'is-negative' : ''}">${fmtMoney(t.net, { sign: true })}</strong></span>`;

  bindSort(table);
  $$('[data-edit]', table).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openTx(b.dataset.edit); }));
  $$('[data-del]', table).forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (await confirmAction('Delete this entry?', 'It will be removed from every total and chart.')) {
      state.transactions = state.transactions.filter((x) => x.id !== b.dataset.del);
      save(); renderAll(); toast('Entry deleted');
    }
  }));
}

function bindSort(table) {
  $$('th[data-sort]', table).forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    ui.txSort = { key: k, dir: ui.txSort.key === k ? -ui.txSort.dir : (k === 'date' || k === 'amount' ? -1 : 1) };
    renderTransactions();
  }));
}

/* ── projects ──────────────────────────────────────────── */
const STATUS_CLASS = { 'Active': 'active', 'On hold': 'hold', 'Completed': 'done', 'Archived': 'off' };

function renderProjects() {
  const grid = $('#projGrid');
  const list = txInRange();
  if (!state.projects.length) {
    grid.innerHTML = `<div class="card" style="grid-column:1/-1">${emptyBlock(
      'Create your first project',
      'Group income and costs by job, client or campaign to see which ones actually make money.',
      '<button class="primary-btn sm" id="projEmptyAdd">Create a project</button>', 'folder')}</div>`;
    $('#projEmptyAdd')?.addEventListener('click', () => openProj());
    return;
  }
  grid.innerHTML = state.projects.map((p) => {
    const own = list.filter((t) => t.project === p.id);
    const t = totals(own);
    const denom = t.income + t.expense || 1;
    const staff = state.employees.filter((e) => e.project === p.id && isActiveEmp(e));
    const budgetPct = p.budget ? clamp((t.expense / Number(p.budget)) * 100, 0, 100) : null;
    return `<article class="card proj-card" data-proj="${p.id}">
      <div class="proj-top">
        <div><div class="proj-name">${esc(p.name)}</div>${p.client ? `<div class="proj-client">${esc(p.client)}</div>` : ''}</div>
        <div class="row-actions" style="opacity:1">
          <span class="status status--${STATUS_CLASS[p.status] || 'off'}"><i></i>${esc(p.status || 'Active')}</span>
          <button class="icon-btn" data-pedit="${p.id}" aria-label="Edit project"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg></button>
        </div>
      </div>
      <div>
        <div class="proj-net"><strong class="${t.net < 0 ? 'is-negative' : ''}">${fmtMoney(t.net, { compact: true, sign: true })}</strong><span>net</span></div>
        <div class="proj-split" style="margin-top:10px">
          <i style="width:${((t.income / denom) * 100).toFixed(1)}%;background:var(--flow-in)"></i>
          <i style="width:${((t.expense / denom) * 100).toFixed(1)}%;background:var(--flow-out)"></i>
        </div>
      </div>
      <div class="proj-stats">
        <div class="proj-stat"><span>Money in</span><b>${fmtMoney(t.income, { compact: true })}</b></div>
        <div class="proj-stat"><span>Money out</span><b>${fmtMoney(t.expense, { compact: true })}</b></div>
        <div class="proj-stat"><span>Margin</span><b class="${t.margin !== null && t.margin < 0 ? 'is-negative' : ''}">${t.margin === null ? '—' : (t.margin * 100).toFixed(0) + '%'}</b></div>
      </div>
      <div class="proj-stats" style="border-top:0;padding-top:0">
        <div class="proj-stat"><span>Entries</span><b>${own.length}</b></div>
        <div class="proj-stat"><span>Team</span><b>${staff.length}</b></div>
        <div class="proj-stat"><span>Budget used</span><b>${budgetPct === null ? '—' : budgetPct.toFixed(0) + '%'}</b></div>
      </div>
    </article>`;
  }).join('');
  $$('[data-proj]', grid).forEach((c) => c.addEventListener('click', () => openProjectDetail(c.dataset.proj)));
  $$('[data-pedit]', grid).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openProj(b.dataset.pedit); }));
}

/* ── project detail ────────────────────────────────────── */
function openProjectDetail(id) {
  ui.detailProjectId = id;
  setView('project-detail');
  renderProjectDetail();
}

function renderProjectDetail() {
  const p = projById(ui.detailProjectId);
  if (!p) {
    $('#pdName').textContent = 'Project not found';
    $('#pdClient').textContent = '';
    $('#pdStatus').hidden = true;
    $('#pdFacts').innerHTML = emptyBlock('Project not found', 'It may have been removed.', '<button class="ghost-btn sm" data-goto="projects">Back to projects</button>');
    $('#pdDesc').style.display = 'none';
    ['pdRevenue', 'pdExpense', 'pdNet'].forEach((id2) => $(`#${id2}`).textContent = '$0');
    $('#pdMargin').textContent = '—';
    $('#pdTeamTable').innerHTML = '';
    $('#pdInTable').innerHTML = '';
    $('#pdOutTable').innerHTML = '';
    $('#pdFlowHost').innerHTML = '';
    $('#pdCatHost').innerHTML = '';
    $('#pdSplit').innerHTML = '';
    $('#pdProfitSpark').innerHTML = '';
    return;
  }

  $('#pdStatus').hidden = false;
  $('#pdName').textContent = p.name;
  $('#pdClient').textContent = p.client || 'No client set';
  $('#pdStatus').className = `status status--${STATUS_CLASS[p.status] || 'off'}`;
  $('#pdStatus').innerHTML = `<i></i>${esc(p.status || 'Active')}`;
  if (p.description) { $('#pdDesc').style.display = ''; $('#pdDesc').textContent = p.description; }
  else $('#pdDesc').style.display = 'none';

  $('#pdFacts').innerHTML =
    `<div class="proj-stat"><span>Budget</span><b>${p.budget ? fmtMoney(Number(p.budget)) : '—'}</b></div>` +
    `<div class="proj-stat"><span>Start date</span><b>${p.startDate ? fmtDate(p.startDate) : '—'}</b></div>` +
    `<div class="proj-stat"><span>End date</span><b>${p.endDate ? fmtDate(p.endDate) : '—'}</b></div>` +
    `<div class="proj-stat"><span>Team size</span><b>${state.employees.filter((e) => e.project === p.id).length}</b></div>`;

  const list = state.transactions.filter((t) => t.project === p.id);
  const t = totals(list);
  $('#pdRevenue').textContent = fmtMoney(t.income, { compact: true });
  $('#pdRevenueSub').textContent = `${list.filter((x) => x.type === 'income').length} entries`;
  $('#pdExpense').textContent = fmtMoney(t.expense, { compact: true });
  $('#pdExpenseSub').textContent = `${list.filter((x) => x.type === 'expense').length} entries`;
  $('#pdNet').textContent = fmtMoney(t.net, { compact: true, sign: true });
  $('#pdNet').classList.toggle('is-negative', t.net < 0);
  $('#pdMargin').textContent = t.margin === null ? '—' : `${(t.margin * 100).toFixed(1)}%`;
  $('#pdMargin').classList.toggle('is-negative', t.margin !== null && t.margin < 0);

  const denom = t.income + t.expense || 1;
  $('#pdSplit').innerHTML =
    `<i style="width:${((t.income / denom) * 100).toFixed(1)}%;background:var(--flow-in)"></i>` +
    `<i style="width:${((t.expense / denom) * 100).toFixed(1)}%;background:var(--flow-out)"></i>`;

  const team = state.employees.filter((e) => e.project === p.id);
  const teamTable = $('#pdTeamTable');
  teamTable.innerHTML = !team.length
    ? `<tbody><tr><td>${emptyBlock('No one assigned', 'Assign employees to this project from the employee form.', '', 'people')}</td></tr></tbody>`
    : `<thead><tr><th>Name</th><th>Role</th><th>Status</th><th class="num">Monthly cost</th></tr></thead><tbody>` +
      team.map((e) => `<tr data-emp="${e.id}" style="cursor:pointer">
        <td><b>${esc(e.name)}</b></td>
        <td style="color:var(--ink-2)">${esc(e.role || '—')}</td>
        <td><span class="status status--${e.status === 'Active' ? 'active' : e.status === 'On leave' ? 'hold' : e.status === 'Contract' ? 'done' : 'off'}"><i></i>${esc(e.status || 'Active')}</span></td>
        <td class="num">${isVariableSalary(e) ? '—' : fmtMoney(monthlyCost(e))}</td>
      </tr>`).join('') + `</tbody>`;
  $$('[data-emp]', teamTable).forEach((tr) => tr.addEventListener('click', () => openEmployeeDetail(tr.dataset.emp)));

  const linkLabel = (tx) => {
    if (tx.employee) return state.employees.find((e) => e.id === tx.employee)?.name || '—';
    if (tx.subscriptionId) return state.subscriptions.find((s) => s.id === tx.subscriptionId)?.platform || '—';
    return tx.vendor || '—';
  };
  const moneyIn = list.filter((x) => x.type === 'income').sort((a, b) => b.date.localeCompare(a.date));
  $('#pdInTable').innerHTML = !moneyIn.length
    ? `<tbody><tr><td>${emptyBlock('No income yet', 'Money in for this project will show up here.', '', 'ledger')}</td></tr></tbody>`
    : `<thead><tr><th>Date</th><th>Amount</th><th>Category</th><th>Method</th><th>Notes</th></tr></thead><tbody>` +
      moneyIn.map((tx) => `<tr>
        <td style="white-space:nowrap">${fmtDate(tx.date)}</td>
        <td class="num amt-in">+${fmtMoney(Number(tx.amount) || 0).replace('−', '')}</td>
        <td>${esc(catName(tx.category))}</td>
        <td style="color:var(--ink-muted)">${esc(tx.method || '—')}</td>
        <td style="color:var(--ink-2)">${esc(tx.description || '—')}</td>
      </tr>`).join('') + `</tbody>`;

  const moneyOut = list.filter((x) => x.type === 'expense').sort((a, b) => b.date.localeCompare(a.date));
  $('#pdOutTable').innerHTML = !moneyOut.length
    ? `<tbody><tr><td>${emptyBlock('No expenses yet', 'Money out for this project will show up here.', '', 'ledger')}</td></tr></tbody>`
    : `<thead><tr><th>Date</th><th>Amount</th><th>Category</th><th>Method</th><th>Linked to</th><th>Notes</th></tr></thead><tbody>` +
      moneyOut.map((tx) => `<tr>
        <td style="white-space:nowrap">${fmtDate(tx.date)}</td>
        <td class="num amt-out">−${fmtMoney(Number(tx.amount) || 0).replace('−', '')}</td>
        <td>${esc(catName(tx.category))}</td>
        <td style="color:var(--ink-muted)">${esc(tx.method || '—')}</td>
        <td style="color:var(--ink-2)">${esc(linkLabel(tx))}</td>
        <td style="color:var(--ink-2)">${esc(tx.description || '—')}</td>
      </tr>`).join('') + `</tbody>`;

  drawProjTrendChart();
  drawProjCategoryChart();
  drawProjProfitSpark();
}

function drawProjProfitSpark() {
  const svg = $('#pdProfitSpark');
  if (!svg) return;
  const p = projById(ui.detailProjectId);
  const list = p ? state.transactions.filter((t) => t.project === p.id) : [];
  const data = monthlySeries(list, { start: null, end: null });
  const W = 320, H = 64;
  if (!p || data.length < 2) { svg.innerHTML = ''; return; }

  const vals = data.map((d) => d.net);
  const lo = Math.min(...vals, 0), hi = Math.max(...vals, 0);
  const span = (hi - lo) || 1;
  const x = (i) => (i / (data.length - 1)) * (W - 6) + 3;
  const y = (v) => H - 6 - ((v - lo) / span) * (H - 12);
  const pts = vals.map((v, i) => [x(i), y(v)]);
  const line = smoothPath(pts);
  const area = `${line}L${x(data.length - 1).toFixed(1)},${y(lo).toFixed(1)}L${x(0).toFixed(1)},${y(lo).toFixed(1)}Z`;
  const last = vals[vals.length - 1];
  const stroke = last < 0 ? 'var(--flow-out)' : 'var(--flow-in)';
  const zeroY = y(0);
  const grad = fadeGradientDef(stroke);

  svg.innerHTML =
    `<defs>${grad.html}</defs>` +
    `<path class="trend-area" d="${area}" fill="url(#${grad.id})"/>` +
    (lo < 0 ? `<line class="grid-line" x1="3" y1="${zeroY.toFixed(1)}" x2="${W - 3}" y2="${zeroY.toFixed(1)}"/>` : '') +
    `<path class="trend-line" id="pdSparkLine" d="${line}" fill="none" stroke="${stroke}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` +
    `<circle cx="${x(data.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="4.5" fill="${stroke}" stroke="var(--surface)" stroke-width="2"/>`;
  animateLineDraw($('#pdSparkLine', svg));
}

/** Grouped-column monthly cash flow, all-time, scoped to one project. */
function drawProjTrendChart() {
  const host = $('#pdFlowHost');
  if (!host || ui.view !== 'project-detail') return;
  const p = projById(ui.detailProjectId);
  const list = p ? state.transactions.filter((t) => t.project === p.id) : [];
  const data = monthlySeries(list, { start: null, end: null });

  if (!p || !data.length || !data.some((d) => d.income || d.expense)) {
    host.onpointermove = host.onpointerleave = null;
    host.innerHTML = emptyBlock('No entries yet', 'Add income or expenses tagged to this project to see cash flow.', '', 'ledger');
    return;
  }

  host.innerHTML = `<svg id="pdFlowChart" role="img" aria-label="Grouped columns comparing money in and money out for each month"></svg><div class="tooltip" id="pdFlowTip" role="status" aria-live="polite"></div>`;
  const svg = $('#pdFlowChart', host);
  const tip = $('#pdFlowTip', host);
  const W = host.clientWidth || 600;
  const H = host.clientHeight || 260;
  const pad = { t: 12, r: 8, b: 26, l: 44 };
  const iw = Math.max(40, W - pad.l - pad.r);
  const ih = Math.max(40, H - pad.t - pad.b);
  const max = Math.max(...data.map((d) => Math.max(d.income, d.expense)), 1);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const yOf = (v) => pad.t + ih - (v / top) * ih;

  const band = iw / data.length;
  const GAP = 2;
  const barW = clamp((band - 16 - GAP) / 2, 3, 24);
  const groupW = barW * 2 + GAP;

  const inGrad = barGradientDef('var(--flow-in)');
  const outGrad = barGradientDef('var(--flow-out)');
  let g = `<defs>${inGrad.html}${outGrad.html}</defs>`;
  ticks.forEach((t) => {
    const y = yOf(t);
    g += `<line class="grid-line" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${(pad.l + iw).toFixed(1)}" y2="${y.toFixed(1)}"/>`;
    g += `<text class="axis-text" x="${pad.l - 9}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${compactAxis(t)}</text>`;
  });
  g += `<line class="axis-line" x1="${pad.l}" y1="${(pad.t + ih).toFixed(1)}" x2="${(pad.l + iw).toFixed(1)}" y2="${(pad.t + ih).toFixed(1)}"/>`;

  const showEvery = Math.ceil(data.length / (iw / 46));
  data.forEach((d, i) => {
    const cx = pad.l + band * i + band / 2;
    const x0 = cx - groupW / 2;
    const hIn = (d.income / top) * ih;
    const hOut = (d.expense / top) * ih;
    const delay = `style="animation-delay:${Math.min(i * 25, 400)}ms"`;
    g += `<rect class="hover-band" data-i="${i}" x="${(pad.l + band * i).toFixed(1)}" y="${pad.t}" width="${band.toFixed(1)}" height="${ih}" rx="6"/>`;
    g += `<path class="bar bar-v" data-i="${i}" ${delay} d="${columnPath(x0, yOf(d.income), barW, hIn)}" fill="url(#${inGrad.id})"/>`;
    g += `<path class="bar bar-v" data-i="${i}" ${delay} d="${columnPath(x0 + barW + GAP, yOf(d.expense), barW, hOut)}" fill="url(#${outGrad.id})"/>`;
    if (i % showEvery === 0 || i === data.length - 1) {
      g += `<text class="axis-text" x="${cx.toFixed(1)}" y="${(pad.t + ih + 17).toFixed(1)}" text-anchor="middle">${monthLabel(d.key)}</text>`;
    }
  });

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = g;

  const bands = $$('.hover-band', svg);
  const bars = $$('.bar', svg);
  const onLeave = () => {
    bands.forEach((b) => b.classList.remove('is-on'));
    host.classList.remove('is-hovering');
    tip.classList.remove('is-on');
  };
  host.onpointermove = (ev) => {
    const rect = host.getBoundingClientRect();
    if (ev.clientX - rect.left < pad.l) { onLeave(); return; }
    const i = clamp(Math.floor(((ev.clientX - rect.left) - pad.l) / band), 0, data.length - 1);
    const d = data[i];
    bands.forEach((b, j) => b.classList.toggle('is-on', j === i));
    bars.forEach((b) => b.classList.toggle('is-hot', +b.dataset.i === i));
    host.classList.add('is-hovering');
    tip.innerHTML =
      `<h4>${monthLabelFull(d.key)}</h4>` +
      `<div class="tooltip-row"><i class="key key-in"></i><span>Money in</span><b>${fmtMoney(d.income)}</b></div>` +
      `<div class="tooltip-row"><i class="key key-out"></i><span>Money out</span><b>${fmtMoney(d.expense)}</b></div>` +
      `<div class="tooltip-sep"></div>` +
      `<div class="tooltip-row"><span>Net</span><b class="${d.net < 0 ? 'is-negative' : ''}">${fmtMoney(d.net, { sign: true })}</b></div>`;
    tip.classList.add('is-on');
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const cx = pad.l + band * i + band / 2;
    tip.style.left = `${clamp(cx - tw / 2, 4, W - tw - 4)}px`;
    tip.style.top = `${clamp(yOf(Math.max(d.income, d.expense)) - th - 10, 4, H - th - 4)}px`;
  };
  host.onpointerleave = onLeave;
}

/** Horizontal ranking bars, expense-by-category, all-time, scoped to one project. */
function drawProjCategoryChart() {
  const host = $('#pdCatHost');
  if (!host || ui.view !== 'project-detail') return;
  const p = projById(ui.detailProjectId);
  const list = (p ? state.transactions.filter((t) => t.project === p.id) : []).filter((t) => t.type === 'expense');

  const byCat = new Map();
  for (const t of list) byCat.set(catName(t.category), (byCat.get(catName(t.category)) || 0) + (Number(t.amount) || 0));
  let rows = [...byCat.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);

  if (!p || !rows.length) {
    host.onpointermove = host.onpointerleave = null;
    host.style.height = '';
    host.innerHTML = emptyBlock('Nothing to break down', 'No costs recorded for this project yet.');
    return;
  }
  if (rows.length > 7) {
    const head = rows.slice(0, 6);
    rows = [...head, { name: 'Other', value: sum(rows.slice(6), (r) => r.value), isOther: true }];
  }

  const H = clamp(rows.length * 38, 180, 420);
  host.style.height = `${H}px`;
  host.innerHTML = `<svg id="pdCatChart" role="img" aria-label="Horizontal bars ranking categories by total amount"></svg><div class="tooltip" id="pdCatTip" role="status" aria-live="polite"></div>`;
  const svg = $('#pdCatChart', host);
  const tip = $('#pdCatTip', host);
  const W = host.clientWidth || 500;
  const labelW = clamp(Math.round(W * 0.32), 90, 168);
  const pad = { t: 4, r: 62, b: 4, l: labelW };
  const iw = Math.max(30, W - pad.l - pad.r);
  const ih = H - pad.t - pad.b;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const band = ih / rows.length;
  const barH = clamp(band - 12, 6, 24);
  const ramp = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5', '--seq-6'];
  const total = sum(rows, (r) => r.value);

  let g = '<defs>';
  const fills = rows.map((r, i) => {
    const base = r.isOther ? 'var(--line-strong)' : `var(${ramp[Math.min(i, ramp.length - 1)]})`;
    const grad = barGradientDef(base);
    g += grad.html;
    return `url(#${grad.id})`;
  });
  g += '</defs>';
  rows.forEach((r, i) => {
    const y = pad.t + band * i + (band - barH) / 2;
    const w = (r.value / max) * iw;
    const name = r.name.length > 22 ? r.name.slice(0, 21) + '…' : r.name;
    g += `<text class="cat-name" x="${pad.l - 12}" y="${(y + barH / 2 + 4).toFixed(1)}" text-anchor="end">${esc(name)}</text>`;
    g += `<rect class="hover-band" data-i="${i}" x="0" y="${(pad.t + band * i).toFixed(1)}" width="${W}" height="${band.toFixed(1)}" rx="6"/>`;
    g += `<path class="bar bar-h" data-i="${i}" style="animation-delay:${i * 45}ms" d="${rowPath(pad.l, y, w, barH)}" fill="${fills[i]}"/>`;
    g += `<text class="bar-label" x="${(pad.l + w + 9).toFixed(1)}" y="${(y + barH / 2 + 4).toFixed(1)}">${fmtMoney(r.value, { compact: true })}</text>`;
  });

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = g;

  const bars = $$('.bar', svg);
  const bands = $$('.hover-band', svg);
  host.onpointermove = (ev) => {
    const rect = host.getBoundingClientRect();
    const i = clamp(Math.floor(((ev.clientY - rect.top) - pad.t) / band), 0, rows.length - 1);
    const r = rows[i];
    bands.forEach((b, j) => b.classList.toggle('is-on', j === i));
    bars.forEach((b) => b.classList.toggle('is-hot', +b.dataset.i === i));
    host.classList.add('is-hovering');
    const share = total ? (r.value / total) * 100 : 0;
    tip.innerHTML = `<h4>${esc(r.name)}</h4>` +
      `<div class="tooltip-row"><span>Total</span><b>${fmtMoney(r.value)}</b></div>` +
      `<div class="tooltip-row"><span>Share</span><b>${share.toFixed(1)}%</b></div>`;
    tip.classList.add('is-on');
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = `${clamp(ev.clientX - rect.left + 14, 4, W - tw - 4)}px`;
    tip.style.top = `${clamp(pad.t + band * i + band / 2 - th / 2, 4, H - th - 4)}px`;
  };
  host.onpointerleave = () => {
    bands.forEach((b) => b.classList.remove('is-on'));
    host.classList.remove('is-hovering');
    tip.classList.remove('is-on');
  };
}

$('#projDetailEdit').addEventListener('click', () => openProj(ui.detailProjectId));

/* ── employees ─────────────────────────────────────────── */
function renderEmployees() {
  const active = state.employees.filter(isActiveEmp);
  const monthly = sum(active, monthlyCost);
  $('#empCount').textContent = state.employees.length;
  $('#empCountSub').textContent = `${active.length} active`;
  $('#empMonthly').textContent = fmtMoney(monthly, { compact: true });
  $('#empAnnual').textContent = fmtMoney(monthly * 12, { compact: true });

  const runs = state.payruns.filter((r) => inRange({ date: r.date }, rangeBounds()));
  $('#empPaid').textContent = fmtMoney(sum(runs, (r) => r.total), { compact: true });
  $('#empPaidSub').textContent = `${runs.length} pay ${runs.length === 1 ? 'run' : 'runs'}`;

  const table = $('#empTable');
  if (!state.employees.length) {
    table.innerHTML = `<tbody><tr><td>${emptyBlock('No employees yet', 'Add your team to track salary cost and post payroll straight to the ledger.', '<button class="primary-btn sm" id="empEmptyAdd">Add an employee</button>', 'people')}</td></tr></tbody>`;
    $('#empEmptyAdd')?.addEventListener('click', () => openEmp());
  } else {
    table.innerHTML =
      `<thead><tr><th>Name</th><th>Department</th><th>Project</th><th>Status</th><th class="num">Salary</th><th class="num">Monthly cost</th><th></th></tr></thead><tbody>` +
      state.employees.map((e) => {
        const st = e.status === 'Active' ? 'active' : e.status === 'On leave' ? 'hold' : e.status === 'Contract' ? 'done' : 'off';
        const variable = isVariableSalary(e);
        const salaryCell = variable
          ? `<span style="color:var(--ink-muted)">Varies</span>`
          : `${fmtMoney(Number(e.salary) || 0)}<small style="color:var(--ink-muted)">${FREQ_LABEL[e.frequency] || ''}</small>`;
        return `<tr data-emp="${e.id}" style="cursor:pointer">
          <td><div class="cell-main"><b>${esc(e.name)}</b>${e.role ? `<small>${esc(e.role)}</small>` : ''}</div></td>
          <td style="color:var(--ink-2)">${esc(e.department || '—')}</td>
          <td>${e.project && projName(e.project) ? `<span class="tag tag--muted">${esc(projName(e.project))}</span>` : '<span class="tag tag--muted">Company-wide</span>'}</td>
          <td><span class="status status--${st}"><i></i>${esc(e.status || 'Active')}</span></td>
          <td class="num">${salaryCell}</td>
          <td class="num">${variable ? '—' : fmtMoney(monthlyCost(e))}</td>
          <td><div class="row-actions">
            <button class="icon-btn" data-eedit="${e.id}" aria-label="Edit employee"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg></button>
            <button class="icon-btn" data-edel="${e.id}" aria-label="Remove employee"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M10 7V5h4v2M8 7l.7 12h6.6L16 7"/></svg></button>
          </div></td>
        </tr>`;
      }).join('') + `</tbody>`;

    $$('[data-emp]', table).forEach((tr) => tr.addEventListener('click', () => openEmployeeDetail(tr.dataset.emp)));
    $$('[data-eedit]', table).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openEmp(b.dataset.eedit); }));
    $$('[data-edel]', table).forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const emp = state.employees.find((x) => x.id === b.dataset.edel);
      if (await confirmAction(`Remove ${emp?.name || 'this employee'}?`, 'Salary expenses already posted to the ledger stay put.')) {
        state.employees = state.employees.filter((x) => x.id !== b.dataset.edel);
        save(); renderAll(); toast('Employee removed');
      }
    }));
  }

  const pt = $('#payrollTable');
  const allRuns = [...state.payruns].sort((a, b) => b.date.localeCompare(a.date));
  if (!allRuns.length) {
    pt.innerHTML = `<tbody><tr><td>${emptyBlock('No pay runs yet', 'Running payroll posts one salary expense per person, tagged to their project.', '', 'ledger')}</td></tr></tbody>`;
  } else {
    pt.innerHTML =
      `<thead><tr><th>Pay date</th><th>Period</th><th class="num">People</th><th class="num">Total</th><th></th></tr></thead><tbody>` +
      allRuns.map((r) => `<tr>
        <td style="white-space:nowrap">${fmtDate(r.date)}</td>
        <td style="color:var(--ink-2)">${esc(r.period || 'Monthly')}</td>
        <td class="num">${r.count}</td>
        <td class="num amt-out">−${fmtMoney(r.total).replace('−', '')}</td>
        <td><div class="row-actions"><button class="icon-btn" data-rdel="${r.id}" aria-label="Reverse pay run"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M10 7V5h4v2M8 7l.7 12h6.6L16 7"/></svg></button></div></td>
      </tr>`).join('') + `</tbody>`;

    $$('[data-rdel]', pt).forEach((b) => b.addEventListener('click', async () => {
      if (await confirmAction('Reverse this pay run?', 'Every salary expense it created will be deleted too.')) {
        const id = b.dataset.rdel;
        state.transactions = state.transactions.filter((t) => t.payrun !== id);
        state.payruns = state.payruns.filter((r) => r.id !== id);
        save(); renderAll(); toast('Pay run reversed');
      }
    }));
  }
}

/* ── employee detail ───────────────────────────────────── */
function openEmployeeDetail(id) {
  ui.detailEmployeeId = id;
  setView('employee-detail');
  renderEmployeeDetail();
}

function renderEmployeeDetail() {
  const emp = state.employees.find((e) => e.id === ui.detailEmployeeId);
  if (!emp) {
    $('#empDetailName').textContent = 'Employee not found';
    $('#empDetailRole').textContent = '';
    $('#empDetailStatus').hidden = true;
    $('#empDetailFacts').innerHTML = emptyBlock('Employee not found', 'It may have been removed.', '<button class="ghost-btn sm" data-goto="employees">Back to employees</button>');
    ['empDetailTotalPaid', 'empDetailAvg'].forEach((id2) => $(`#${id2}`).textContent = '$0');
    $('#empDetailLast').textContent = '—';
    $('#empDetailLastSub').textContent = '—';
    $('#empDetailCount').textContent = '0';
    $('#empHistoryTable').innerHTML = '';
    $('#empTrendHost').innerHTML = '';
    return;
  }
  $('#empDetailStatus').hidden = false;
  $('#empDetailName').textContent = emp.name;
  $('#empDetailRole').textContent = [emp.role, emp.department].filter(Boolean).join(' · ') || '—';
  const st = emp.status === 'Active' ? 'active' : emp.status === 'On leave' ? 'hold' : emp.status === 'Contract' ? 'done' : 'off';
  $('#empDetailStatus').className = `status status--${st}`;
  $('#empDetailStatus').innerHTML = `<i></i>${esc(emp.status || 'Active')}`;

  const variable = isVariableSalary(emp);
  $('#empDetailFacts').innerHTML =
    `<div class="proj-stat"><span>Salary type</span><b>${esc(FREQ_SELECT_LABEL[emp.frequency] || '—')}</b></div>` +
    `<div class="proj-stat"><span>Base rate</span><b>${variable ? 'Varies' : fmtMoney(Number(emp.salary) || 0)}</b></div>` +
    `<div class="proj-stat"><span>Project</span><b>${emp.project && projName(emp.project) ? esc(projName(emp.project)) : 'Company-wide'}</b></div>` +
    `<div class="proj-stat"><span>Start date</span><b>${emp.startDate ? fmtDate(emp.startDate) : '—'}</b></div>`;

  const history = state.transactions.filter((t) => t.employee === emp.id).sort((a, b) => b.date.localeCompare(a.date) || (b.created || 0) - (a.created || 0));
  const totalPaid = sum(history, (t) => Number(t.amount) || 0);
  $('#empDetailTotalPaid').textContent = fmtMoney(totalPaid, { compact: true });
  const months = new Set(history.map((t) => monthKey(t.date))).size;
  $('#empDetailAvg').textContent = fmtMoney(months ? totalPaid / months : 0, { compact: true });
  $('#empDetailLast').textContent = history.length ? fmtMoney(Number(history[0].amount) || 0, { compact: true }) : '—';
  $('#empDetailLastSub').textContent = history.length ? fmtDate(history[0].date) : 'No payments yet';
  $('#empDetailCount').textContent = history.length;

  const table = $('#empHistoryTable');
  if (!history.length) {
    table.innerHTML = `<tbody><tr><td>${emptyBlock('No payments yet', 'Run payroll to post the first salary expense for this person.', '', 'ledger')}</td></tr></tbody>`;
  } else {
    table.innerHTML = `<thead><tr><th>Date</th><th>Reference</th><th>Project</th><th class="num">Amount</th></tr></thead><tbody>` +
      history.map((t) => `<tr>
        <td style="white-space:nowrap">${fmtDate(t.date)}</td>
        <td style="color:var(--ink-2)">${esc(t.reference || '—')}</td>
        <td>${t.project && projName(t.project) ? esc(projName(t.project)) : '—'}</td>
        <td class="num amt-out">−${fmtMoney(Number(t.amount) || 0).replace('−', '')}</td>
      </tr>`).join('') + `</tbody>`;
  }
  drawEmpTrendChart();
}

/** Single-series bar chart, all-time (ignores the topbar date filter). */
function drawEmpTrendChart() {
  const host = $('#empTrendHost');
  if (!host || ui.view !== 'employee-detail') return;
  const emp = state.employees.find((e) => e.id === ui.detailEmployeeId);
  const list = emp ? state.transactions.filter((t) => t.employee === emp.id) : [];
  const data = monthlySeries(list, { start: null, end: null });

  if (!emp || !data.length || !data.some((d) => d.expense)) {
    host.onpointermove = host.onpointerleave = null;
    host.innerHTML = emptyBlock('No payments yet', 'Salary paid to this person will show up here.', '', 'ledger');
    return;
  }

  host.innerHTML = `<svg id="empTrendChart" role="img" aria-label="Bar chart of salary paid per month"></svg><div class="tooltip" id="empTrendTip" role="status" aria-live="polite"></div>`;
  const svg = $('#empTrendChart', host);
  const tip = $('#empTrendTip', host);
  const W = host.clientWidth || 600;
  const H = host.clientHeight || 260;
  const pad = { t: 12, r: 8, b: 26, l: 44 };
  const iw = Math.max(40, W - pad.l - pad.r);
  const ih = Math.max(40, H - pad.t - pad.b);
  const max = Math.max(...data.map((d) => d.expense), 1);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const yOf = (v) => pad.t + ih - (v / top) * ih;

  const band = iw / data.length;
  const barW = clamp(band - 16, 3, 40);

  const barGrad = barGradientDef('var(--flow-out)');
  let g = `<defs>${barGrad.html}</defs>`;
  ticks.forEach((t) => {
    const y = yOf(t);
    g += `<line class="grid-line" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${(pad.l + iw).toFixed(1)}" y2="${y.toFixed(1)}"/>`;
    g += `<text class="axis-text" x="${pad.l - 9}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${compactAxis(t)}</text>`;
  });
  g += `<line class="axis-line" x1="${pad.l}" y1="${(pad.t + ih).toFixed(1)}" x2="${(pad.l + iw).toFixed(1)}" y2="${(pad.t + ih).toFixed(1)}"/>`;

  const showEvery = Math.ceil(data.length / (iw / 46));
  data.forEach((d, i) => {
    const cx = pad.l + band * i + band / 2;
    const h = (d.expense / top) * ih;
    g += `<rect class="hover-band" data-i="${i}" x="${(pad.l + band * i).toFixed(1)}" y="${pad.t}" width="${band.toFixed(1)}" height="${ih}" rx="6"/>`;
    g += `<path class="bar bar-v" data-i="${i}" style="animation-delay:${Math.min(i * 25, 400)}ms" d="${columnPath(cx - barW / 2, yOf(d.expense), barW, h)}" fill="url(#${barGrad.id})"/>`;
    if (i % showEvery === 0 || i === data.length - 1) {
      g += `<text class="axis-text" x="${cx.toFixed(1)}" y="${(pad.t + ih + 17).toFixed(1)}" text-anchor="middle">${monthLabel(d.key)}</text>`;
    }
  });

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = g;

  const bands = $$('.hover-band', svg);
  const bars = $$('.bar', svg);
  const onLeave = () => {
    bands.forEach((b) => b.classList.remove('is-on'));
    host.classList.remove('is-hovering');
    tip.classList.remove('is-on');
  };
  host.onpointermove = (ev) => {
    const rect = host.getBoundingClientRect();
    const xRel = ev.clientX - rect.left;
    if (xRel < pad.l) { onLeave(); return; }
    const i = clamp(Math.floor((xRel - pad.l) / band), 0, data.length - 1);
    const d = data[i];
    bands.forEach((b, j) => b.classList.toggle('is-on', j === i));
    bars.forEach((b) => b.classList.toggle('is-hot', +b.dataset.i === i));
    host.classList.add('is-hovering');
    tip.innerHTML = `<h4>${monthLabelFull(d.key)}</h4><div class="tooltip-row"><span>Paid</span><b>${fmtMoney(d.expense)}</b></div>`;
    tip.classList.add('is-on');
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const cx = pad.l + band * i + band / 2;
    tip.style.left = `${clamp(cx - tw / 2, 4, W - tw - 4)}px`;
    tip.style.top = `${clamp(yOf(d.expense) - th - 10, 4, H - th - 4)}px`;
  };
  host.onpointerleave = onLeave;
}

$('#empDetailEdit').addEventListener('click', () => openEmp(ui.detailEmployeeId));

/* ── categories ────────────────────────────────────────── */
function renderCategories() {
  const list = txInRange();
  ['income', 'expense'].forEach((type) => {
    const host = $(type === 'income' ? '#catListIncome' : '#catListExpense');
    const cats = state.categories.filter((c) => c.type === type);
    if (!cats.length) {
      host.innerHTML = `<li>${emptyBlock('No categories', `Add a ${type === 'income' ? 'revenue' : 'cost'} category to start tagging entries.`, '', 'tag')}</li>`;
      return;
    }
    const withTotals = cats.map((c) => ({
      ...c, total: sum(list.filter((t) => t.category === c.id), (t) => Number(t.amount) || 0),
      count: list.filter((t) => t.category === c.id).length,
    })).sort((a, b) => b.total - a.total);
    const peak = Math.max(...withTotals.map((c) => c.total), 1);
    const grand = sum(withTotals, (c) => c.total);

    host.innerHTML = withTotals.map((c) => `<li>
      <div class="cat-info">
        <b>${esc(c.name)}</b>
        <div class="cat-meter">
          <div class="mini-bar"><i style="width:${((c.total / peak) * 100).toFixed(0)}%;background:${type === 'income' ? 'var(--flow-in)' : 'var(--flow-out)'}"></i></div>
          <small>${c.count} ${c.count === 1 ? 'entry' : 'entries'}${grand ? ' · ' + ((c.total / grand) * 100).toFixed(0) + '%' : ''}</small>
        </div>
      </div>
      <span class="cat-amt">${fmtMoney(c.total, { compact: true })}</span>
      <div class="row-actions">
        <button class="icon-btn" data-cedit="${c.id}" aria-label="Edit category"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg></button>
      </div>
    </li>`).join('');

    $$('[data-cedit]', host).forEach((b) => b.addEventListener('click', () => openCat(b.dataset.cedit)));
  });
}

/* ── subscriptions ─────────────────────────────────────── */
function renderSubscriptions() {
  const subs = state.subscriptions;
  $('#navCountSub').textContent = subs.length;
  const active = subs.filter(isActiveSub);
  $('#subCount').textContent = active.length;
  $('#subCountSub').textContent = `${subs.length} total`;
  const monthly = sum(active, monthlySubCost);
  $('#subMonthly').textContent = fmtMoney(monthly, { compact: true });
  $('#subAnnual').textContent = fmtMoney(monthly * 12, { compact: true });
  const upcoming = [...active].filter((s) => s.renewalDate).sort((a, b) => a.renewalDate.localeCompare(b.renewalDate))[0];
  $('#subNext').textContent = upcoming ? fmtDate(upcoming.renewalDate) : '—';
  $('#subNextSub').textContent = upcoming ? upcoming.platform : 'No active subscriptions';

  const table = $('#subTable');
  if (!subs.length) {
    table.innerHTML = `<tbody><tr><td>${emptyBlock('No subscriptions yet', 'Track recurring software and platform costs here — charges post to the ledger automatically on each renewal.', '<button class="primary-btn sm" id="subEmptyAdd">Add a subscription</button>', 'cards')}</td></tr></tbody>`;
    $('#subEmptyAdd')?.addEventListener('click', () => openSub());
    return;
  }
  table.innerHTML =
    `<thead><tr><th>Platform</th><th>Category</th><th class="num">Amount</th><th>Renewal</th><th>Method</th><th>Status</th><th></th></tr></thead><tbody>` +
    [...subs].sort((a, b) => (a.renewalDate || '').localeCompare(b.renewalDate || '')).map((s) => {
      const st = s.status === 'Active' ? 'active' : s.status === 'Paused' ? 'hold' : 'off';
      return `<tr>
        <td><div class="cell-main"><b>${esc(s.platform)}</b>${s.notes ? `<small>${esc(s.notes)}</small>` : ''}</div></td>
        <td style="color:var(--ink-2)">${esc(s.category || '—')}</td>
        <td class="num">${fmtMoney(Number(s.amount) || 0)}<small style="color:var(--ink-muted)">${s.billingCycle === 'yearly' ? '/year' : '/month'}</small></td>
        <td style="white-space:nowrap">${s.renewalDate ? fmtDate(s.renewalDate) : '—'}</td>
        <td style="color:var(--ink-muted)">${esc(s.paymentMethod || '—')}</td>
        <td><span class="status status--${st}"><i></i>${esc(s.status || 'Active')}</span></td>
        <td><div class="row-actions">
          <button class="icon-btn" data-subedit="${s.id}" aria-label="Edit subscription"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg></button>
          <button class="icon-btn" data-subdel="${s.id}" aria-label="Delete subscription"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M10 7V5h4v2M8 7l.7 12h6.6L16 7"/></svg></button>
        </div></td>
      </tr>`;
    }).join('') + `</tbody>`;

  $$('[data-subedit]', table).forEach((b) => b.addEventListener('click', () => openSub(b.dataset.subedit)));
  $$('[data-subdel]', table).forEach((b) => b.addEventListener('click', async () => {
    const s = state.subscriptions.find((x) => x.id === b.dataset.subdel);
    if (await confirmAction(`Delete ${s?.platform}?`, 'Past charges already posted to the ledger stay put.')) {
      state.subscriptions = state.subscriptions.filter((x) => x.id !== b.dataset.subdel);
      save(); renderAll(); toast('Subscription deleted');
    }
  }));
}

let editingSub = null;
function openSub(id) {
  const form = $('#subForm');
  form.reset();
  editingSub = id ? state.subscriptions.find((s) => s.id === id) : null;
  $('#subModalTitle').textContent = editingSub ? 'Edit subscription' : 'New subscription';
  $('#subDelete').hidden = !editingSub;
  refreshSelects();
  const el = form.elements;
  if (editingSub) {
    el.platform.value = editingSub.platform;
    el.category.value = editingSub.category || '';
    el.billingCycle.value = editingSub.billingCycle || 'monthly';
    el.amount.value = editingSub.amount || '';
    el.currency.value = editingSub.currency || state.settings.currency || 'USD';
    el.renewalDate.value = editingSub.renewalDate || '';
    $('#subMethod').value = editingSub.paymentMethod || '';
    $('#subProject').value = editingSub.project || '';
    el.status.value = editingSub.status || 'Active';
    el.notes.value = editingSub.notes || '';
  } else {
    el.renewalDate.value = todayISO();
    el.currency.value = state.settings.currency || 'USD';
  }
  syncSelectLabels(form);
  $('#subModal').showModal();
}

$('#subForm').addEventListener('submit', (e) => {
  const f = e.target.elements;
  const platform = f.platform.value.trim();
  if (!platform) { e.preventDefault(); toast('Give the subscription a platform name', 'warn'); return; }
  const rec = {
    id: editingSub?.id || uid(),
    platform, category: f.category.value.trim(),
    billingCycle: f.billingCycle.value, amount: Number(f.amount.value) || 0,
    currency: f.currency.value, renewalDate: f.renewalDate.value || todayISO(),
    paymentMethod: $('#subMethod').value || '', project: $('#subProject').value || '',
    status: f.status.value, notes: f.notes.value.trim(),
  };
  if (editingSub) state.subscriptions = state.subscriptions.map((s) => (s.id === rec.id ? rec : s));
  else state.subscriptions.push(rec);
  advanceSubscriptions();
  save(); renderAll(); toast(editingSub ? 'Subscription updated' : 'Subscription added');
});

$('#subDelete').addEventListener('click', async () => {
  if (!editingSub) return;
  if (await confirmAction(`Delete ${editingSub.platform}?`, 'Past charges already posted to the ledger stay put.')) {
    state.subscriptions = state.subscriptions.filter((s) => s.id !== editingSub.id);
    save(); renderAll(); $('#subModal').close(); toast('Subscription deleted');
  }
});

$('#addSubBtn').addEventListener('click', () => openSub());

/* ── payment methods ───────────────────────────────────── */
function renderPaymentMethods() {
  const host = $('#methodList');
  if (!state.paymentMethods.length) {
    host.innerHTML = `<li>${emptyBlock('No payment methods', 'Add one to start tagging how money moved.', '', 'tag')}</li>`;
    return;
  }
  host.innerHTML = state.paymentMethods.map((m) => `<li>
    <div class="cat-info"><b>${esc(m.name)}</b></div>
    <div class="row-actions">
      <button class="icon-btn" data-medit="${m.id}" aria-label="Edit method"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg></button>
      <button class="icon-btn" data-mdel="${m.id}" aria-label="Delete method"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M10 7V5h4v2M8 7l.7 12h6.6L16 7"/></svg></button>
    </div>
  </li>`).join('');
  $$('[data-medit]', host).forEach((b) => b.addEventListener('click', () => openMethod(b.dataset.medit)));
  $$('[data-mdel]', host).forEach((b) => b.addEventListener('click', async () => {
    const m = state.paymentMethods.find((x) => x.id === b.dataset.mdel);
    if (await confirmAction(`Delete "${m?.name}"?`, 'Entries already using this method keep it as plain text.')) {
      state.paymentMethods = state.paymentMethods.filter((x) => x.id !== b.dataset.mdel);
      save(); renderAll(); toast('Payment method deleted');
    }
  }));
}

let editingMethod = null;
function openMethod(id) {
  const form = $('#methodForm');
  form.reset();
  editingMethod = id ? state.paymentMethods.find((m) => m.id === id) : null;
  $('#methodModalTitle').textContent = editingMethod ? 'Edit method' : 'New method';
  $('#methodDelete').hidden = !editingMethod;
  if (editingMethod) form.elements.name.value = editingMethod.name;
  $('#methodModal').showModal();
}

$('#methodForm').addEventListener('submit', (e) => {
  const f = e.target.elements;
  const name = f.name.value.trim();
  if (!name) { e.preventDefault(); toast('Give the method a name', 'warn'); return; }
  if (editingMethod) state.paymentMethods = state.paymentMethods.map((m) => (m.id === editingMethod.id ? { ...m, name } : m));
  else state.paymentMethods.push({ id: uid(), name });
  save(); renderAll(); toast(editingMethod ? 'Method updated' : 'Method added');
});

$('#methodDelete').addEventListener('click', async () => {
  if (!editingMethod) return;
  if (await confirmAction(`Delete "${editingMethod.name}"?`, 'Entries already using this method keep it as plain text.')) {
    state.paymentMethods = state.paymentMethods.filter((m) => m.id !== editingMethod.id);
    save(); renderAll(); $('#methodModal').close(); toast('Payment method deleted');
  }
});

$('#addMethodBtn').addEventListener('click', () => openMethod());

/* ── shared selects ────────────────────────────────────── */
function refreshSelects() {
  const catOpts = (type) => state.categories.filter((c) => c.type === type)
    .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  const projOpts = state.projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const methodOpts = state.paymentMethods.map((m) => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('');
  const empOpts = state.employees.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
  const subOpts = state.subscriptions.filter(isActiveSub).map((s) => `<option value="${s.id}">${esc(s.platform)}</option>`).join('');

  const keepValue = (sel, html) => { const v = sel.value; sel.innerHTML = html; sel.value = v; };

  keepValue($('#txCatFilter'), `<option value="">All categories</option>` +
    `<optgroup label="Money in">${catOpts('income')}</optgroup><optgroup label="Money out">${catOpts('expense')}</optgroup>`);
  keepValue($('#txProjFilter'), `<option value="">All projects</option>${projOpts}`);
  keepValue($('#txProject'), `<option value="">— No project —</option>${projOpts}`);
  keepValue($('#empProject'), `<option value="">— Company-wide —</option>${projOpts}`);
  keepValue($('#txMethod'), methodOpts);
  keepValue($('#subProject'), `<option value="">— No project —</option>${projOpts}`);
  keepValue($('#subMethod'), `<option value="">— Not set —</option>${methodOpts}`);
  keepValue($('#breakdownProject'), `<option value="">All projects</option>${projOpts}`);
  const txFields = ensureTxFieldNodes();
  keepValue(txFields.employee.querySelector('#txEmployee'), `<option value="">— Select employee —</option>${empOpts}`);
  keepValue(txFields.sub.querySelector('#txSub'), `<option value="">— Select subscription —</option>${subOpts}`);
}

function fillTxCategories(type, selected) {
  const sel = $('#txCategory');
  sel.innerHTML = state.categories.filter((c) => c.type === type)
    .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  if (selected && sel.querySelector(`option[value="${selected}"]`)) sel.value = selected;
  updateTxContextFields();
}

/** Cached references to the Employee/Subscription/Vendor field <label>s,
 *  captured once from their original DOM position before we ever start
 *  detaching them (ensures refreshSelects() can still reach the <select>s
 *  inside even while they're removed from the document). */
let txFieldNodes = null;
function ensureTxFieldNodes() {
  if (!txFieldNodes) {
    txFieldNodes = {
      employee: document.getElementById('txEmployeeField'),
      sub: document.getElementById('txSubField'),
      vendor: document.getElementById('txVendorField'),
    };
  }
  return txFieldNodes;
}

/** Inserts/removes the Employee, Subscription and Vendor fields from the
 *  New Entry form's DOM entirely — not just hidden — based on the
 *  selected category's name. Same name-matching approach payroll already
 *  uses to find/create "Salaries & wages". */
function updateTxContextFields() {
  const nodes = ensureTxFieldNodes();
  const form = $('#txForm');
  const anchor = form.querySelector('.field--full'); // Description — always present
  const opt = $('#txCategory').selectedOptions[0];
  const name = opt ? opt.textContent : '';
  const show = {
    employee: /salar/i.test(name),
    sub: /subscri/i.test(name),
    vendor: /vendor/i.test(name),
  };
  for (const key of Object.keys(show)) {
    const node = nodes[key];
    if (show[key] && !node.isConnected) anchor.parentNode.insertBefore(node, anchor);
    else if (!show[key] && node.isConnected) node.remove();
  }
}

/* ═══════════════════════════════════════════════════════
   Modals / CRUD
   ═══════════════════════════════════════════════════════ */
let editingTx = null, editingProj = null, editingEmp = null, editingCat = null;

function openTx(id) {
  const form = $('#txForm');
  form.reset();
  editingTx = id ? state.transactions.find((t) => t.id === id) : null;
  $('#txModalTitle').textContent = editingTx ? 'Edit entry' : 'New entry';
  $('#txDelete').hidden = !editingTx;
  refreshSelects();

  // NB: read fields off form.elements — `form.name`/`form.method` are native
  // HTMLFormElement properties and would shadow the inputs of the same name.
  const el = form.elements;
  const type = editingTx?.type || 'income';
  form.querySelector(`input[name="type"][value="${type}"]`).checked = true;
  fillTxCategories(type, editingTx?.category);
  el.date.value = editingTx?.date || todayISO();
  if (editingTx) {
    el.amount.value = editingTx.amount;
    el.description.value = editingTx.description || '';
    el.method.value = editingTx.method || 'Bank transfer';
    el.reference.value = editingTx.reference || '';
    $('#txProject').value = editingTx.project || '';
    // these three only exist in the form when their category matches —
    // updateTxContextFields() (run inside fillTxCategories above) has
    // already inserted whichever one applies to editingTx.category
    if (el.employee) el.employee.value = editingTx.employee || '';
    if (el.subscriptionId) el.subscriptionId.value = editingTx.subscriptionId || '';
    if (el.vendor) el.vendor.value = editingTx.vendor || '';
  }
  syncSelectLabels(form);
  $('#txModal').showModal();
  setTimeout(() => el.amount.focus(), 50);
}

$('#txForm').addEventListener('submit', (e) => {
  const f = e.target.elements;
  const amount = Math.abs(Number(f.amount.value) || 0);
  if (!amount) { e.preventDefault(); toast('Enter an amount above zero', 'warn'); return; }
  const rec = {
    id: editingTx?.id || uid(),
    created: editingTx?.created || Date.now(),
    type: f.type.value,
    amount,
    date: f.date.value || todayISO(),
    category: f.category.value,
    project: $('#txProject').value || '',
    description: f.description.value.trim(),
    method: f.method.value,
    reference: f.reference.value.trim(),
    // these three only exist in the DOM (and thus in f) when their
    // category is selected; if the category was changed away from one
    // that needs them, they're rightly cleared rather than left stale
    employee: f.employee ? f.employee.value : '',
    subscriptionId: f.subscriptionId ? f.subscriptionId.value : '',
    vendor: f.vendor ? f.vendor.value.trim() : '',
  };
  if (editingTx) state.transactions = state.transactions.map((t) => (t.id === rec.id ? { ...t, ...rec } : t));
  else state.transactions.push(rec);
  save(); renderAll();
  toast(editingTx ? 'Entry updated' : `${rec.type === 'income' ? 'Money in' : 'Money out'} recorded`);
});

$$('#txForm input[name="type"]').forEach((r) => r.addEventListener('change', () => fillTxCategories(r.value)));
$('#txCategory').addEventListener('change', updateTxContextFields);

$('#txDelete').addEventListener('click', async () => {
  if (!editingTx) return;
  if (await confirmAction('Delete this entry?', 'It will be removed from every total and chart.')) {
    state.transactions = state.transactions.filter((t) => t.id !== editingTx.id);
    save(); renderAll(); $('#txModal').close(); toast('Entry deleted');
  }
});

/* projects */
function openProj(id) {
  const form = $('#projForm');
  form.reset();
  editingProj = id ? projById(id) : null;
  $('#projModalTitle').textContent = editingProj ? 'Edit project' : 'New project';
  $('#projDelete').hidden = !editingProj;
  const el = form.elements;
  if (editingProj) {
    el.name.value = editingProj.name;
    el.client.value = editingProj.client || '';
    el.status.value = editingProj.status || 'Active';
    el.budget.value = editingProj.budget || '';
    el.startDate.value = editingProj.startDate || '';
    el.endDate.value = editingProj.endDate || '';
    el.description.value = editingProj.description || '';
  } else el.startDate.value = todayISO();
  syncSelectLabels(form);
  $('#projModal').showModal();
}

$('#projForm').addEventListener('submit', (e) => {
  const f = e.target.elements;
  const rec = {
    id: editingProj?.id || uid(),
    name: f.name.value.trim(), client: f.client.value.trim(),
    status: f.status.value, budget: Number(f.budget.value) || 0, startDate: f.startDate.value,
    endDate: f.endDate.value, description: f.description.value.trim(),
  };
  if (!rec.name) { e.preventDefault(); toast('Give the project a name', 'warn'); return; }
  if (editingProj) state.projects = state.projects.map((p) => (p.id === rec.id ? rec : p));
  else state.projects.push(rec);
  save(); renderAll(); toast(editingProj ? 'Project updated' : 'Project created');
});

$('#projDelete').addEventListener('click', async () => {
  if (!editingProj) return;
  const n = state.transactions.filter((t) => t.project === editingProj.id).length;
  if (await confirmAction(`Delete ${editingProj.name}?`, n ? `${n} entries will keep their amounts but lose the project tag.` : 'This project has no entries yet.')) {
    state.projects = state.projects.filter((p) => p.id !== editingProj.id);
    state.transactions = state.transactions.map((t) => (t.project === editingProj.id ? { ...t, project: '' } : t));
    state.employees = state.employees.map((e2) => (e2.project === editingProj.id ? { ...e2, project: '' } : e2));
    save(); renderAll(); $('#projModal').close(); toast('Project deleted');
  }
});

/* employees */
function openEmp(id) {
  const form = $('#empForm');
  form.reset();
  editingEmp = id ? state.employees.find((e) => e.id === id) : null;
  $('#empModalTitle').textContent = editingEmp ? 'Edit employee' : 'Add employee';
  $('#empDelete').hidden = !editingEmp;
  refreshSelects();
  const el = form.elements;
  if (editingEmp) {
    el.name.value = editingEmp.name;
    el.role.value = editingEmp.role || '';
    el.department.value = editingEmp.department || 'Engineering';
    el.status.value = editingEmp.status || 'Active';
    el.salary.value = editingEmp.salary || '';
    el.frequency.value = editingEmp.frequency || 'monthly';
    el.startDate.value = editingEmp.startDate || '';
    $('#empProject').value = editingEmp.project || '';
  } else el.startDate.value = todayISO();
  updateEmpHint();
  syncSelectLabels(form);
  $('#empModal').showModal();
}

function updateEmpHint() {
  const f = $('#empForm').elements;
  const variable = VARIABLE_FREQUENCIES.has(f.frequency.value);
  f.salary.required = !variable;
  f.salary.placeholder = variable ? 'Entered at each payment' : '0.00';
  if (variable) {
    $('#empCostHint').textContent = 'No fixed amount — you\'ll enter what was actually paid each time payroll runs.';
    return;
  }
  const m = (Number(f.salary.value) || 0) * (FREQ_TO_MONTHLY[f.frequency.value] ?? 1);
  $('#empCostHint').textContent = m
    ? `Costs ${fmtMoney(m)} per month · ${fmtMoney(m * 12)} per year${f.frequency.value === 'hourly' ? ' (assuming 160 hours a month)' : f.frequency.value === 'daily' ? ' (assuming 22 working days a month)' : ''}.`
    : 'Enter a salary to see the monthly and annual cost.';
}
['input', 'change'].forEach((ev) => $('#empForm').addEventListener(ev, updateEmpHint));

$('#empForm').addEventListener('submit', (e) => {
  const f = e.target.elements;
  const rec = {
    id: editingEmp?.id || uid(),
    name: f.name.value.trim(), role: f.role.value.trim(),
    department: f.department.value, status: f.status.value,
    salary: Number(f.salary.value) || 0, frequency: f.frequency.value,
    project: $('#empProject').value || '', startDate: f.startDate.value,
  };
  if (!rec.name) { e.preventDefault(); toast('Enter the employee name', 'warn'); return; }
  if (editingEmp) state.employees = state.employees.map((x) => (x.id === rec.id ? rec : x));
  else state.employees.push(rec);
  save(); renderAll(); toast(editingEmp ? 'Employee updated' : `${rec.name} added to the roster`);
});

$('#empDelete').addEventListener('click', async () => {
  if (!editingEmp) return;
  if (await confirmAction(`Remove ${editingEmp.name}?`, 'Salary expenses already posted to the ledger stay put.')) {
    state.employees = state.employees.filter((x) => x.id !== editingEmp.id);
    save(); renderAll(); $('#empModal').close(); toast('Employee removed');
  }
});

/* categories */
function openCat(id) {
  const form = $('#catForm');
  form.reset();
  editingCat = id ? catById(id) : null;
  $('#catModalTitle').textContent = editingCat ? 'Edit category' : 'New category';
  $('#catDelete').hidden = !editingCat;
  if (editingCat) { form.elements.name.value = editingCat.name; form.elements.type.value = editingCat.type; }
  syncSelectLabels(form);
  $('#catModal').showModal();
}

$('#catForm').addEventListener('submit', (e) => {
  const f = e.target.elements;
  const name = f.name.value.trim();
  if (!name) { e.preventDefault(); toast('Give the category a name', 'warn'); return; }
  if (editingCat) state.categories = state.categories.map((c) => (c.id === editingCat.id ? { ...c, name, type: f.type.value } : c));
  else state.categories.push({ id: uid(), name, type: f.type.value });
  save(); renderAll(); toast(editingCat ? 'Category updated' : 'Category added');
});

$('#catDelete').addEventListener('click', async () => {
  if (!editingCat) return;
  const n = state.transactions.filter((t) => t.category === editingCat.id).length;
  if (await confirmAction(`Delete "${editingCat.name}"?`, n ? `${n} entries will show as Uncategorised.` : 'No entries use this category.')) {
    state.categories = state.categories.filter((c) => c.id !== editingCat.id);
    save(); renderAll(); $('#catModal').close(); toast('Category deleted');
  }
});

/* payroll */
const PERIOD_FACTOR = { monthly: 1, biweekly: 12 / 26, weekly: 12 / 52 };
const PERIOD_LABEL = { monthly: 'Monthly', biweekly: 'Two weeks', weekly: 'Weekly' };

function openPayroll() {
  const roster = state.employees.filter((e) => e.status === 'Active' || e.status === 'Contract');
  if (!roster.length) { toast('Add an active employee first', 'warn'); return; }
  const form = $('#payrollForm');
  form.elements.date.value = todayISO();
  form.elements.period.value = 'monthly';
  syncSelectLabels(form);
  $('#payrollList').innerHTML = roster.map((e) => {
    const variable = isVariableSalary(e);
    return `<li>
      <input type="checkbox" data-pay="${e.id}" checked>
      <div class="cell-main"><b>${esc(e.name)}</b><small>${esc(e.role || e.department || '')}${e.project && projName(e.project) ? ' · ' + esc(projName(e.project)) : ''}${variable ? ' · ' + esc(FREQ_SELECT_LABEL[e.frequency] || 'Variable') : ''}</small></div>
      ${variable
        ? `<div class="amount-input payroll-amt"><b class="cur-sym">$</b><input type="number" step="0.01" min="0" placeholder="0.00" data-amt-input="${e.id}"></div>`
        : `<span class="num" data-amt="${e.id}"></span>`}
    </li>`;
  }).join('');
  updatePayrollTotal();
  $('#payrollModal').showModal();
}

function updatePayrollTotal() {
  const factor = PERIOD_FACTOR[$('#payrollForm').elements.period.value] ?? 1;
  let total = 0;
  $$('#payrollList [data-pay]').forEach((cb) => {
    const emp = state.employees.find((e) => e.id === cb.dataset.pay);
    if (!emp) return;
    if (isVariableSalary(emp)) {
      const input = $(`[data-amt-input="${emp.id}"]`);
      if (cb.checked) total += Number(input?.value) || 0;
    } else {
      const amt = monthlyCost(emp) * factor;
      $(`[data-amt="${emp.id}"]`).textContent = fmtMoney(amt);
      if (cb.checked) total += amt;
    }
  });
  $('#payrollTotal').textContent = fmtMoney(total);
}
['change', 'input'].forEach((ev) => $('#payrollForm').addEventListener(ev, updatePayrollTotal));

$('#payrollForm').addEventListener('submit', (e) => {
  const f = e.target.elements;
  const factor = PERIOD_FACTOR[f.period.value] ?? 1;
  const picked = $$('#payrollList [data-pay]').filter((cb) => cb.checked).map((cb) => cb.dataset.pay);
  if (!picked.length) { e.preventDefault(); toast('Select at least one person', 'warn'); return; }

  let salaryCat = state.categories.find((c) => c.type === 'expense' && /salar/i.test(c.name));
  if (!salaryCat) { salaryCat = { id: uid(), name: 'Salaries & wages', type: 'expense' }; state.categories.push(salaryCat); }

  const runId = uid();
  const date = f.date.value || todayISO();
  let total = 0, skipped = 0;
  picked.forEach((id) => {
    const emp = state.employees.find((x) => x.id === id);
    if (!emp) return;
    let amount;
    if (isVariableSalary(emp)) {
      amount = Math.round((Number($(`[data-amt-input="${id}"]`)?.value) || 0) * 100) / 100;
      if (!amount) { skipped++; return; }
    } else {
      amount = Math.round(monthlyCost(emp) * factor * 100) / 100;
    }
    total += amount;
    state.transactions.push({
      id: uid(), created: Date.now(), type: 'expense', amount, date,
      category: salaryCat.id, project: emp.project || '',
      description: `Salary — ${emp.name}`, method: 'Bank transfer',
      reference: `Payroll ${PERIOD_LABEL[f.period.value]}`, payrun: runId, employee: emp.id,
    });
  });
  if (!total) { e.preventDefault(); toast('Enter an amount for at least one person', 'warn'); return; }
  const count = picked.length - skipped;
  state.payruns.push({ id: runId, date, period: PERIOD_LABEL[f.period.value], count, total });
  save(); renderAll();
  toast(`Payroll posted — ${fmtMoney(total)} across ${count} ${count === 1 ? 'person' : 'people'}`);
});

/* confirm dialog as a promise */
let confirmResolve = null;
function confirmAction(title, text) {
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmModal').showModal();
  return new Promise((res) => { confirmResolve = res; });
}
$('#confirmOk').addEventListener('click', () => { $('#confirmModal').close(); confirmResolve?.(true); confirmResolve = null; });
$('#confirmModal').addEventListener('close', () => { confirmResolve?.(false); confirmResolve = null; });

/* ═══════════════════════════════════════════════════════
   Google Sheets sync — the dashboard stays the source of truth; this
   mirrors it into a spreadsheet as a live backup/reporting layer.
   Talks to a Cloudflare Pages Function (functions/api/sheets-sync.js)
   that holds the Google service-account credentials server-side —
   nothing in this file ever sees the private key.
   ═══════════════════════════════════════════════════════ */
const SHEETS_ENDPOINT = '/api/sheets-sync';
const SHEETS_META_KEY = 'pl-dashboard:sheets';

function loadSheetsMeta() {
  try {
    const p = JSON.parse(localStorage.getItem(SHEETS_META_KEY) || '{}');
    return {
      autoSync: p.autoSync !== false,
      connected: p.connected || false,
      lastSyncAt: p.lastSyncAt || null,
      lastStatus: p.lastStatus || 'idle', // idle | pending | syncing | success | error
      log: Array.isArray(p.log) ? p.log : [],
    };
  } catch {
    return { autoSync: true, connected: false, lastSyncAt: null, lastStatus: 'idle', log: [] };
  }
}
let sheetsMeta = loadSheetsMeta();
function saveSheetsMeta() {
  try { localStorage.setItem(SHEETS_META_KEY, JSON.stringify(sheetsMeta)); } catch { /* non-critical */ }
}
function sheetsLog(type, message) {
  sheetsMeta.log.unshift({ time: Date.now(), type, message });
  sheetsMeta.log = sheetsMeta.log.slice(0, 20);
  saveSheetsMeta();
  renderSheetsPanel();
}

/** Resolves the friendly display strings the spreadsheet should show
 *  (names, not internal ids) and recomputes the derived financial
 *  columns (Projects' revenue/expenses/profit, Employees' total paid)
 *  using the exact same totals()/sum() helpers the dashboard itself
 *  renders from — never stored redundantly in state. */
function buildSheetsPayload() {
  const empName = (id) => state.employees.find((e) => e.id === id)?.name || '';
  const subPlatform = (id) => state.subscriptions.find((sub) => sub.id === id)?.platform || '';

  const transactions = state.transactions.map((t) => ({
    date: t.date, type: t.type, category: catName(t.category), project: projName(t.project) || '',
    employee: empName(t.employee), subscription: subPlatform(t.subscriptionId), vendor: t.vendor || '',
    method: t.method || '', amount: Number(t.amount) || 0, currency: state.settings.currency || 'USD',
    notes: t.description || '',
  }));

  const projects = state.projects.map((p) => {
    const tot = totals(state.transactions.filter((t) => t.project === p.id));
    return { name: p.name, revenue: tot.income, expenses: tot.expense, profit: tot.net, status: p.status || '', client: p.client || '' };
  });

  const employees = state.employees.map((e) => ({
    name: e.name,
    salaryType: FREQ_SELECT_LABEL[e.frequency] || e.frequency || '',
    salary: Number(e.salary) || 0,
    totalPaid: sum(state.transactions.filter((t) => t.employee === e.id), (t) => Number(t.amount) || 0),
    status: e.status || '',
  }));

  const subscriptions = state.subscriptions.map((sub) => ({
    platform: sub.platform, monthlyCost: monthlySubCost(sub), renewalDate: sub.renewalDate || '',
    paymentMethod: sub.paymentMethod || '', status: sub.status || '',
  }));

  return { transactions, projects, employees, subscriptions, paymentMethods: state.paymentMethods.map((m) => m.name) };
}

let sheetsSyncTimer = null;
/** Called from the single save() call site — debounces rapid successive
 *  saves into one sync call, and self-heals from failures since every
 *  sync sends the complete current state rather than a queued diff. */
function scheduleSheetsSync() {
  if (sheetsMeta.lastStatus !== 'syncing') sheetsMeta.lastStatus = 'pending';
  renderSyncIndicator();
  clearTimeout(sheetsSyncTimer);
  sheetsSyncTimer = setTimeout(() => {
    if (sheetsMeta.autoSync) runSheetsSync();
    else renderSyncIndicator();
  }, 800);
}

async function runSheetsSync() {
  clearTimeout(sheetsSyncTimer);
  sheetsMeta.lastStatus = 'syncing';
  renderSyncIndicator();
  try {
    const resp = await fetch(SHEETS_ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSheetsPayload()),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) throw new Error(data.error || `Sync failed (${resp.status})`);
    sheetsMeta.lastStatus = 'success';
    sheetsMeta.lastSyncAt = Date.now();
    sheetsMeta.connected = true;
    sheetsLog('ok', 'Synced successfully');
  } catch (err) {
    sheetsMeta.lastStatus = 'error';
    sheetsLog('error', String(err.message || err));
  }
  saveSheetsMeta();
  renderSyncIndicator();
}

async function testSheetsConnection() {
  sheetsMeta.lastStatus = 'syncing';
  renderSyncIndicator();
  try {
    const resp = await fetch(SHEETS_ENDPOINT);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) throw new Error(data.error || `Connection failed (${resp.status})`);
    sheetsMeta.connected = true;
    sheetsMeta.lastStatus = 'success';
    sheetsLog('ok', `Connected — "${data.title}" (${(data.sheets || []).join(', ')})`);
    toast('Connected to Google Sheets');
  } catch (err) {
    sheetsMeta.connected = false;
    sheetsMeta.lastStatus = 'error';
    sheetsLog('error', String(err.message || err));
    toast('Could not connect to Google Sheets', 'bad');
  }
  saveSheetsMeta();
  renderSyncIndicator();
}

function renderSyncIndicator() {
  const btn = $('#sheetsIndicator');
  if (!btn) return;
  const st = sheetsMeta.lastStatus;
  const busy = st === 'syncing' || st === 'pending';
  const mode = !sheetsMeta.connected && st !== 'error' ? 'off' : st === 'error' ? 'error' : busy ? 'busy' : 'ok';
  const label = mode === 'off' ? 'Google Sheets — not connected'
    : mode === 'error' ? 'Google Sheets — sync error'
    : mode === 'busy' ? 'Google Sheets — syncing…'
    : 'Google Sheets — synced';
  btn.className = `icon-btn sync-indicator sync-indicator--${mode}`;
  btn.title = sheetsMeta.lastSyncAt ? `${label} (last: ${new Date(sheetsMeta.lastSyncAt).toLocaleString()})` : label;
}

function renderSheetsPanel() {
  const toggle = $('#sheetsAutoSync');
  if (!toggle) return; // Settings markup not present yet — fine, called again once it is
  toggle.checked = sheetsMeta.autoSync;
  $('#sheetsStatusPill').textContent = sheetsMeta.connected ? 'Connected' : 'Not connected';
  $('#sheetsStatusPill').className = `status ${sheetsMeta.connected ? 'status--active' : 'status--off'}`;
  $('#sheetsLastSync').textContent = sheetsMeta.lastSyncAt ? new Date(sheetsMeta.lastSyncAt).toLocaleString() : 'Never';
  const logHost = $('#sheetsLogList');
  logHost.innerHTML = sheetsMeta.log.length
    ? sheetsMeta.log.map((e) => `<li class="sheets-log-row${e.type === 'error' ? ' is-bad' : ''}"><span>${new Date(e.time).toLocaleTimeString()}</span><span>${esc(e.message)}</span></li>`).join('')
    : '<li class="sheets-log-row"><span>—</span><span>No sync activity yet</span></li>';
  renderSyncIndicator();
}

$('#sheetsConnectBtn')?.addEventListener('click', testSheetsConnection);
$('#sheetsSyncNowBtn')?.addEventListener('click', runSheetsSync);
$('#sheetsAutoSync')?.addEventListener('change', (e) => {
  sheetsMeta.autoSync = e.target.checked;
  saveSheetsMeta();
  toast(e.target.checked ? 'Auto sync enabled' : 'Auto sync disabled');
});

/* ═══════════════════════════════════════════════════════
   Import / export
   ═══════════════════════════════════════════════════════ */
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function download(name, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ledgerCsv(rows) {
  const head = ['Date', 'Direction', 'Category', 'Project', 'Description', 'Method', 'Reference', 'Amount', 'Currency'];
  const body = rows.map((t) => [
    t.date, t.type === 'income' ? 'Money in' : 'Money out',
    catName(t.category), projName(t.project) || '', t.description || '',
    t.method || '', t.reference || '',
    (t.type === 'income' ? 1 : -1) * (Number(t.amount) || 0),
    state.settings.currency,
  ].map(csvCell).join(','));
  return [head.join(','), ...body].join('\n');
}

/* ═══════════════════════════════════════════════════════
   Sample data
   ═══════════════════════════════════════════════════════ */
function seedDemo() {
  const s = blankState();
  s.settings = { company: 'Northgate Studio', currency: state.settings.currency || 'USD' };
  const cat = (name) => s.categories.find((c) => c.name === name).id;

  s.projects = [
    { id: uid(), name: 'Meridian Rebrand',   client: 'Meridian Foods',  status: 'Active',    budget: 180000, startDate: '2025-11-04' },
    { id: uid(), name: 'Atlas Mobile App',   client: 'Atlas Logistics', status: 'Active',    budget: 320000, startDate: '2026-01-12' },
    { id: uid(), name: 'Harbor Retainer',    client: 'Harbor Group',    status: 'Active',    budget: 96000,  startDate: '2025-09-01' },
    { id: uid(), name: 'Vela Site Refresh',  client: 'Vela Cosmetics',  status: 'Completed', budget: 74000,  startDate: '2025-08-15' },
  ];
  const P = s.projects.map((p) => p.id);

  s.employees = [
    { id: uid(), name: 'Jordan Reyes',   role: 'Engineering Lead',   department: 'Engineering', status: 'Active',   salary: 11500, frequency: 'monthly', project: P[1], startDate: '2024-03-11' },
    { id: uid(), name: 'Priya Nandakumar', role: 'Senior Designer',  department: 'Engineering', status: 'Active',   salary: 9200,  frequency: 'monthly', project: P[0], startDate: '2024-07-22' },
    { id: uid(), name: 'Marcus Bell',    role: 'Account Director',   department: 'Sales',       status: 'Active',   salary: 128000, frequency: 'annual', project: '',   startDate: '2023-11-06' },
    { id: uid(), name: 'Sofia Lindqvist', role: 'Frontend Engineer', department: 'Engineering', status: 'Active',   salary: 8400,  frequency: 'monthly', project: P[1], startDate: '2025-02-17' },
    { id: uid(), name: 'Dev Kapoor',     role: 'Growth Marketer',    department: 'Marketing',   status: 'Active',   salary: 7100,  frequency: 'monthly', project: '',   startDate: '2025-05-05' },
    { id: uid(), name: 'Elena Moreau',   role: 'Finance Manager',    department: 'Finance',     status: 'Active',   salary: 8800,  frequency: 'monthly', project: '',   startDate: '2024-01-15' },
    { id: uid(), name: 'Tomas Vidal',    role: 'QA Contractor',      department: 'Engineering', status: 'Contract', salary: 78,    frequency: 'hourly',  project: P[1], startDate: '2026-02-02' },
  ];

  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  s.subscriptions = [
    { id: uid(), platform: 'Claude AI',  category: 'AI tools',      billingCycle: 'monthly', amount: 200, currency: s.settings.currency, renewalDate: daysAgo(3),  paymentMethod: 'Card',   project: '',   status: 'Active', notes: '' },
    { id: uid(), platform: 'Cloudflare', category: 'Hosting',       billingCycle: 'monthly', amount: 25,  currency: s.settings.currency, renewalDate: daysAgo(10), paymentMethod: 'Card',   project: P[1], status: 'Active', notes: '' },
    { id: uid(), platform: 'OpenAI',     category: 'AI tools',      billingCycle: 'monthly', amount: 120, currency: s.settings.currency, renewalDate: daysAgo(1),  paymentMethod: 'Card',   project: '',   status: 'Active', notes: '' },
    { id: uid(), platform: 'GitHub',     category: 'Dev tools',     billingCycle: 'monthly', amount: 44,  currency: s.settings.currency, renewalDate: daysAgo(15), paymentMethod: 'Card',   project: '',   status: 'Active', notes: 'Team plan' },
    { id: uid(), platform: 'Figma',      category: 'Design tools',  billingCycle: 'yearly',  amount: 540, currency: s.settings.currency, renewalDate: daysAgo(40), paymentMethod: 'PayPal', project: '',   status: 'Active', notes: '' },
    { id: uid(), platform: 'Slack',      category: 'Productivity',  billingCycle: 'monthly', amount: 80,  currency: s.settings.currency, renewalDate: daysAgo(6),  paymentMethod: 'Card',   project: '',   status: 'Paused', notes: '' },
  ];

  // 14 months of plausible activity
  const now = new Date();
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const push = (o) => s.transactions.push({ id: uid(), created: Date.now() - Math.random() * 1e7, method: 'Bank transfer', reference: '', ...o });

  for (let back = 13; back >= 0; back--) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const day = (n) => `${ym}-${String(n).padStart(2, '0')}`;
    const growth = 1 + (13 - back) * 0.035;

    push({ type: 'income', date: day(4),  amount: Math.round(rand(26000, 40000) * growth), category: cat('Retainers'),      project: P[2], description: 'Harbor Group — monthly retainer' });
    push({ type: 'income', date: day(12), amount: Math.round(rand(38000, 72000) * growth), category: cat('Client revenue'), project: pick([P[0], P[1]]), description: `Invoice ${1200 + back * 3}` });
    if (back % 2 === 0) push({ type: 'income', date: day(21), amount: Math.round(rand(18000, 46000) * growth), category: cat('Client revenue'), project: pick([P[0], P[1], P[3]]), description: `Invoice ${1350 + back * 3} — milestone` });
    if (back % 3 === 0) push({ type: 'income', date: day(26), amount: Math.round(rand(4000, 12000)), category: cat('Product sales'), project: '', description: 'Template pack sales' });
    push({ type: 'income', date: day(28), amount: Math.round(rand(200, 900)), category: cat('Interest & other'), project: '', description: 'Deposit interest' });

    const payroll = Math.round(sum(s.employees.filter((e) => e.frequency !== 'hourly'), monthlyCost));
    push({ type: 'expense', date: day(28), amount: payroll, category: cat('Salaries & wages'), project: '', description: 'Monthly payroll', reference: 'Payroll Monthly' });
    push({ type: 'expense', date: day(15), amount: Math.round(rand(6000, 14000)), category: cat('Contractors'),       project: pick(P), description: 'Contract engineering' });
    push({ type: 'expense', date: day(2),  amount: Math.round(rand(1800, 3200)),  category: cat('Software & tools'),  project: '', description: 'SaaS subscriptions' });
    push({ type: 'expense', date: day(9),  amount: Math.round(rand(4500, 16000) * growth), category: cat('Marketing & ads'), project: pick([P[0], P[1]]), description: 'Paid acquisition' });
    push({ type: 'expense', date: day(1),  amount: 7400, category: cat('Rent & utilities'), project: '', description: 'Studio rent & utilities' });
    if (back % 4 === 1) push({ type: 'expense', date: day(18), amount: Math.round(rand(2200, 6800)), category: cat('Travel'), project: pick(P), description: 'Client visit & travel' });
    if (back % 5 === 2) push({ type: 'expense', date: day(20), amount: Math.round(rand(3000, 11000)), category: cat('Equipment'), project: '', description: 'Hardware refresh' });
    if (back % 3 === 1) push({ type: 'expense', date: day(23), amount: Math.round(rand(1500, 4200)), category: cat('Professional fees'), project: '', description: 'Legal & accounting' });
    if (d.getMonth() % 3 === 0) push({ type: 'expense', date: day(24), amount: Math.round(rand(9000, 22000)), category: cat('Taxes'), project: '', description: 'Quarterly tax provision' });
  }

  state = s;
  advanceSubscriptions();
  save();
}

/* ═══════════════════════════════════════════════════════
   Chrome: nav, theme, toasts, wiring
   ═══════════════════════════════════════════════════════ */
const VIEW_META = {
  overview:     ['Overview',     'Every dollar in and out, at a glance'],
  transactions: ['Transactions', 'The full ledger of money movements'],
  projects:     ['Projects',     'Profitability broken out per job'],
  employees:    ['Employees',    'Roster, salary cost and payroll'],
  subscriptions: ['Subscriptions', 'Recurring software & platform costs'],
  'employee-detail': ['Employee', 'Salary history and payment trend'],
  'project-detail': ['Project', 'Financial detail for this project'],
  categories:   ['Categories',   'How money is labelled on the way in and out'],
  settings:     ['Settings',     'Company details, backups and data'],
};

function setView(name) {
  ui.view = name;
  $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === name));
  const [title, sub] = VIEW_META[name] || VIEW_META.overview;
  $('#viewTitle').textContent = title;
  $('#viewSub').textContent = sub;
  const HIDE_RANGE = new Set(['settings', 'categories', 'subscriptions', 'employee-detail', 'project-detail']);
  $('#rangeWrap').style.display = HIDE_RANGE.has(name) ? 'none' : '';
  closeSidebar();
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (name === 'overview') requestAnimationFrame(() => { drawFlowChart(); drawCategoryChart(); drawSparkline(); });
  if (name === 'employee-detail') requestAnimationFrame(drawEmpTrendChart);
  if (name === 'project-detail') requestAnimationFrame(() => { drawProjTrendChart(); drawProjCategoryChart(); });
}

$$('.nav-item').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
document.addEventListener('click', (e) => {
  const goto = e.target.closest('[data-goto]');
  if (goto) setView(goto.dataset.goto);
});

/* theme */
function applyTheme(mode) {
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  localStorage.setItem(THEME_KEY, mode);
  if (ui.view === 'overview') requestAnimationFrame(() => { drawFlowChart(); drawCategoryChart(); drawSparkline(); });
}
$('#themeToggle').addEventListener('click', () => {
  const current = localStorage.getItem(THEME_KEY) || 'system';
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = current === 'dark' || (current === 'system' && prefersDark);
  applyTheme(isDark ? 'light' : 'dark');
});
applyTheme(localStorage.getItem(THEME_KEY) || 'dark');

/* sidebar (mobile) */
const openSidebar = () => { $('#sidebar').classList.add('is-open'); $('#scrim').classList.add('is-on'); };
const closeSidebar = () => { $('#sidebar').classList.remove('is-open'); $('#scrim').classList.remove('is-on'); };
$('#menuBtn').addEventListener('click', openSidebar);
$('#scrim').addEventListener('click', closeSidebar);

/* toasts */
function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'warn' ? 'is-warn' : kind === 'bad' ? 'is-bad' : ''}`;
  el.innerHTML = `<i></i><span>${esc(msg)}</span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('is-out'); setTimeout(() => el.remove(), 220); }, 2800);
}

/* modal close buttons */
$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

/* toolbar wiring */
$('#addTxBtn').addEventListener('click', () => openTx());
$('#addProjBtn').addEventListener('click', () => openProj());
$('#addEmpBtn').addEventListener('click', () => openEmp());
$('#addCatBtn').addEventListener('click', () => openCat());
$('#runPayrollBtn').addEventListener('click', openPayroll);

let rangeSelectPrevValue = $('#rangeSelect').value;
let customRangeApplied = false;
$('#rangeSelect').addEventListener('change', (e) => {
  if (e.target.value === 'custom') {
    const f = $('#customRangeForm').elements;
    f.start.value = ui.customStart || rangeBounds('30d').start;
    f.end.value = ui.customEnd || todayISO();
    $('#customRangeModal').showModal();
    return;
  }
  rangeSelectPrevValue = e.target.value;
  ui.range = e.target.value;
  ui.periodOffset = 0;          // always land on the current period first
  renderPeriodBar();
  renderAll();
});

/* ── period stepper ────────────────────────────────────── */
/** Shows the arrows only for steppable periods, and stops "next" from
 *  walking into the future where there is nothing to show. */
function renderPeriodBar() {
  const bar = $('#periodBar');
  if (!bar) return;
  const stepping = isPeriodKind(ui.range);
  bar.hidden = !stepping;
  if (!stepping) return;
  $('#periodCurrent').textContent = currentRangeLabel();
  $('#periodNext').disabled = ui.periodOffset >= 0;
  $('#periodCurrent').disabled = ui.periodOffset === 0;
  bar.classList.toggle('is-past', ui.periodOffset !== 0);
}
function stepPeriod(by) {
  if (!isPeriodKind(ui.range)) return;
  const next = ui.periodOffset + by;
  if (next > 0) return;
  ui.periodOffset = next;
  renderPeriodBar();
  renderAll();
}
$('#periodPrev').addEventListener('click', () => stepPeriod(-1));
$('#periodNext').addEventListener('click', () => stepPeriod(1));
$('#periodCurrent').addEventListener('click', () => {
  ui.periodOffset = 0; renderPeriodBar(); renderAll();
});
// arrow keys step the period when you're not typing into something
document.addEventListener('keydown', (e) => {
  if (!isPeriodKind(ui.range)) return;
  if (e.target.matches('input, select, textarea') || document.querySelector('dialog[open]')) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); stepPeriod(-1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); stepPeriod(1); }
});
$('#customRangeForm').addEventListener('submit', (e) => {
  const f = e.target.elements;
  if (!f.start.value || !f.end.value || f.start.value > f.end.value) {
    e.preventDefault(); toast('Pick a valid start and end date', 'warn'); return;
  }
  ui.customStart = f.start.value; ui.customEnd = f.end.value; ui.range = 'custom';
  $('#rangeSelect').value = 'custom'; rangeSelectPrevValue = 'custom';
  customRangeApplied = true;
  renderAll();
});
$('#customRangeModal').addEventListener('close', () => {
  if (!customRangeApplied) { $('#rangeSelect').value = rangeSelectPrevValue; syncSelectLabels(); }
  customRangeApplied = false;
});
$('#customRangeCancel').addEventListener('click', () => $('#customRangeModal').close());
$('#txSearch').addEventListener('input', (e) => { ui.txSearch = e.target.value; renderTransactions(); });
$('#txTypeFilter').addEventListener('change', (e) => { ui.txType = e.target.value; renderTransactions(); });
$('#txCatFilter').addEventListener('change', (e) => { ui.txCat = e.target.value; renderTransactions(); });
$('#txProjFilter').addEventListener('change', (e) => { ui.txProj = e.target.value; renderTransactions(); });
$('#txExport').addEventListener('click', () => {
  const rows = filteredTx();
  if (!rows.length) return toast('Nothing to export', 'warn');
  download(`ledger-${todayISO()}.csv`, ledgerCsv(rows), 'text/csv');
  toast(`Exported ${rows.length} entries`);
});

$$('#breakdownSeg .seg-btn').forEach((b) => b.addEventListener('click', () => {
  ui.breakdownDir = b.dataset.dir;
  $$('#breakdownSeg .seg-btn').forEach((x) => { x.classList.toggle('is-on', x === b); x.setAttribute('aria-selected', x === b); });
  drawCategoryChart();
}));
$('#breakdownProject').addEventListener('change', (e) => { ui.breakdownProject = e.target.value; drawCategoryChart(); });

/* settings */
$('#setCompany').addEventListener('input', (e) => { state.settings.company = e.target.value; save(); $('#brandCompany').textContent = e.target.value || 'My Company'; });
$('#setCurrency').addEventListener('change', (e) => { state.settings.currency = e.target.value; save(); renderAll(); });

$('#exportJson').addEventListener('click', () => {
  download(`pl-dashboard-backup-${todayISO()}.json`, JSON.stringify(state, null, 2), 'application/json');
  toast('Backup downloaded');
});
$('#exportAllCsv').addEventListener('click', () => {
  if (!state.transactions.length) return toast('Nothing to export', 'warn');
  download(`ledger-full-${todayISO()}.csv`, ledgerCsv([...state.transactions].sort((a, b) => a.date.localeCompare(b.date))), 'text/csv');
  toast('Ledger exported');
});
$('#importJson').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!Array.isArray(parsed.transactions)) throw new Error('bad shape');
    if (await confirmAction('Restore this backup?', 'It replaces everything currently in the dashboard.')) {
      state = { ...blankState(), ...parsed, settings: { ...blankState().settings, ...(parsed.settings || {}) } };
      save(); hydrateSettings(); renderAll(); toast('Backup restored');
    }
  } catch { toast('That file is not a valid backup', 'bad'); }
  e.target.value = '';
});
$('#loadDemo').addEventListener('click', async () => {
  if (await confirmAction('Load sample data?', 'This replaces anything currently in the dashboard.')) {
    seedDemo(); hydrateSettings(); renderAll(); setView('overview'); toast('Sample company loaded');
  }
});
$('#wipeData').addEventListener('click', async () => {
  if (await confirmAction('Erase everything?', 'Every entry, project and employee will be permanently deleted.')) {
    state = blankState(); save(); hydrateSettings(); renderAll(); setView('overview'); toast('All data erased');
  }
});

function hydrateSettings() {
  $('#setCompany').value = state.settings.company || '';
  $('#setCurrency').value = state.settings.currency || 'USD';
  renderStorageHint();
  renderSheetsPanel();
}

/* keyboard shortcuts */
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !document.querySelector('dialog[open]')) { e.preventDefault(); openTx(); }
  if (e.key === '/' && !document.querySelector('dialog[open]')) { e.preventDefault(); setView('transactions'); $('#txSearch').focus(); }
});

/* redraw charts on resize */
let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (ui.view === 'overview') { drawFlowChart(); drawCategoryChart(); } }, 120);
}).observe($('#content'));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (ui.view === 'overview') { drawFlowChart(); drawCategoryChart(); drawSparkline(); }
});

/* ═══════════════════════════════════════════════════════
   Motion & atmosphere
   Everything below is presentation only — if any of it is switched off
   (touch device, reduced-motion, or the Settings toggle) the dashboard
   behaves exactly as it did before, just still.
   ═══════════════════════════════════════════════════════ */
const MOTION_KEY = 'pl-dashboard:motion';
const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let motionOn = localStorage.getItem(MOTION_KEY) !== 'off';
function motionAllowed() { return motionOn && !prefersReducedMotion(); }

function applyMotionPref() {
  document.documentElement.classList.toggle('no-motion', !motionAllowed());
  const box = $('#setMotion');
  if (box) box.checked = motionOn;
}

$('#setMotion')?.addEventListener('change', (e) => {
  motionOn = e.target.checked;
  localStorage.setItem(MOTION_KEY, motionOn ? 'on' : 'off');
  applyMotionPref();
  toast(motionOn ? 'Motion enabled' : 'Motion switched off');
});

/* ── numbers that climb instead of snapping ────────────── */
const easeOutExpo = (x) => (x === 1 ? 1 : 1 - Math.pow(2, -10 * x));
/** Ticks an element from its previous number to the new one. Falls back
 *  to a plain write when motion is off or the value hasn't changed. */
function animateCount(el, to, format) {
  if (!el) return;
  el._countFmt = format;               // kept so hover can replay the same formatting
  const prev = Number(el.dataset.countVal);
  // first ever paint has no previous value — sweep up from zero, which
  // makes the dashboard land rather than just appear
  const from = Number.isFinite(prev) ? prev : 0;
  el.dataset.countVal = String(to);
  if (!motionAllowed() || from === to) { el.textContent = format(to); el._countRaf = null; return; }
  if (el._countRaf) cancelAnimationFrame(el._countRaf);
  const start = performance.now(), dur = 620, span = to - from;
  const step = (now) => {
    const k = Math.min((now - start) / dur, 1);
    el.textContent = format(from + span * easeOutExpo(k));
    // cleared on the last frame — replayCount() uses this to tell
    // whether an animation is still in flight
    if (k < 1) el._countRaf = requestAnimationFrame(step);
    else el._countRaf = null;
  };
  el._countRaf = requestAnimationFrame(step);
}

/* ── motivation, driven by the actual numbers ──────────── */
function motivationFor(t, list) {
  if (!list.length) return ['Every empire starts at zero. Log your first move.'];
  if (t.net > 0 && t.margin !== null && t.margin >= 0.3) return [
    'Margins like this are earned, not given. Keep the standard.',
    `${(t.margin * 100).toFixed(0)}% margin. You are compounding — do not coast.`,
    'Profitable and disciplined. Now go find the next lever.',
  ];
  if (t.net > 0) return [
    'In the black. Protect it, then push further.',
    'Momentum is real. Stack another good month on top.',
    'You are winning quietly. Keep the receipts coming.',
  ];
  if (t.net < 0) return [
    'Down this period — but the ledger is not the verdict. Adjust and go again.',
    'Every strong balance sheet has a chapter that looked like this.',
    'Cut what is not working. Double down on what is. Keep moving.',
  ];
  return ['Flat is a starting line, not a finish. Make the next move.'];
}
let motivationTimer = null, motivationIdx = 0;
function renderMotivation(t, list) {
  const el = $('.motivation-text');
  if (!el) return;
  const lines = motivationFor(t, list);
  clearInterval(motivationTimer);
  motivationIdx = motivationIdx % lines.length;
  el.textContent = lines[motivationIdx];
  if (lines.length < 2 || !motionAllowed()) return;
  motivationTimer = setInterval(() => {
    el.classList.add('is-swapping');
    setTimeout(() => {
      motivationIdx = (motivationIdx + 1) % lines.length;
      el.textContent = lines[motivationIdx];
      el.classList.remove('is-swapping');
    }, 400);
  }, 11000);
}

/* ═══════════════════════════════════════════════════════
   Drag to rearrange
   Order is persisted per-container and reapplied with CSS `order`, so
   it survives the full re-renders that renderAll() does. Reordering
   during a drag uses FLIP (measure → mutate → invert → play) so cards
   glide to their new slots instead of snapping.
   ═══════════════════════════════════════════════════════ */
const LAYOUT_KEY = 'pl-dashboard:layout';
function loadLayout() {
  try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}'); } catch { return {}; }
}
let layout = loadLayout();
function saveLayout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* non-critical */ }
}

const GRIP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 9h14M5 15h14"/></svg>';

/** Applies the saved order to a container's items via CSS `order`. */
function applyOrder(container, key, items) {
  const saved = layout[key];
  if (!saved) return;
  items.forEach((el) => {
    const id = el.dataset.dragId;
    const i = saved.indexOf(id);
    el.style.order = i === -1 ? 999 : i;
  });
}

function makeReorderable(container, key, itemSelector, idOf) {
  if (!container) return;
  const items = $$(itemSelector, container).filter((el) => el.parentElement === container);
  items.forEach((el) => {
    el.dataset.dragId = idOf(el);
    if (!$('.drag-handle', el)) {
      const h = document.createElement('button');
      h.type = 'button';
      h.className = 'drag-handle';
      h.title = 'Drag to rearrange';
      h.setAttribute('aria-label', 'Drag to rearrange');
      h.innerHTML = GRIP_SVG;
      h.addEventListener('pointerdown', (e) => startDrag(e, el, container, key, itemSelector));
      // never let a grab bubble into the card's own click (project cards
      // navigate to their detail page on click)
      h.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
      el.appendChild(h);
    }
  });
  applyOrder(container, key, items);
}

function startDrag(e, el, container, key, itemSelector) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();

  const items = () => $$(itemSelector, container)
    .filter((n) => n.parentElement === container)
    .sort((a, b) => (Number(a.style.order) || 0) - (Number(b.style.order) || 0));

  let list = items();
  // normalise: make sure every item has an explicit order to reshuffle
  list.forEach((n, i) => { if (!n.style.order) n.style.order = i; });
  list = items();

  const startX = e.clientX, startY = e.clientY;
  let dragging = false;

  const onMove = (ev) => {
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if (!dragging) {
      if (Math.hypot(dx, dy) < 6) return;   // tolerance so a click isn't read as a drag
      dragging = true;
      el.classList.add('is-dragging');
      document.body.classList.add('is-reordering');
    }
    el.style.transform = `translate(${dx}px, ${dy}px)`;

    // which slot is the pointer currently over?
    const over = items().find((n) => {
      if (n === el) return false;
      const r = n.getBoundingClientRect();
      return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    });
    if (!over) return;

    const cur = items();
    const from = cur.indexOf(el);
    let to = cur.indexOf(over);
    if (from < 0 || to < 0) return;

    // land before or after the hovered card depending on which half the
    // pointer is in — without this, a drag "sticks" one slot short of
    // where it was aimed. Same-row neighbours compare on x, stacked
    // ones on y, so this reads correctly in both the column layout and
    // the 2-D project grid.
    const r = over.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const sameRow = Math.abs(r.top - er.top) < Math.min(r.height, er.height) * 0.5;
    const past = sameRow ? ev.clientX > r.left + r.width / 2 : ev.clientY > r.top + r.height / 2;
    if (past && to < from) to += 1;
    if (!past && to > from) to -= 1;
    if (from === to) return;

    // FLIP: measure every sibling, reorder, then animate the delta away
    const others = cur.filter((n) => n !== el);
    const first = new Map(others.map((n) => [n, n.getBoundingClientRect()]));

    const next = cur.filter((n) => n !== el);
    next.splice(to, 0, el);
    next.forEach((n, i) => { n.style.order = i; });

    others.forEach((n) => {
      const a = first.get(n), b = n.getBoundingClientRect();
      const ox = a.left - b.left, oy = a.top - b.top;
      if (!ox && !oy) return;
      n.classList.remove('drag-shift');
      n.style.transform = `translate(${ox}px, ${oy}px)`;
      void n.offsetWidth;                     // flush, so the transition below actually runs
      n.classList.add('drag-shift');
      n.style.transform = '';
    });
  };

  const onUp = () => {
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    document.body.classList.remove('is-reordering');
    el.classList.remove('is-dragging');
    el.style.transform = '';
    $$(itemSelector, container).forEach((n) => { n.classList.remove('drag-shift'); n.style.transform = ''; });
    if (!dragging) return;
    layout[key] = items().map((n) => n.dataset.dragId);
    saveLayout();
    toast('Layout saved');
  };

  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
}

/** (Re)wires drag handles. Called after every render since the project
 *  grid is rebuilt from scratch each time. */
function refreshReorderables() {
  makeReorderable($('.view[data-view="overview"]'), 'overview', '[data-block]', (el) => el.dataset.block);
  makeReorderable($('#projGrid'), 'projects', '.proj-card', (el) => el.dataset.proj);
}

/* ── boot ──────────────────────────────────────────────── */
/** Paints from the local cache first so the UI is never blank, then
 *  reconciles against the shared copy. Demo data is only ever seeded
 *  when the *server* is confirmed empty — otherwise a fresh browser
 *  would seed demo rows over everyone else's real data. */
async function boot() {
  enhanceAllSelects();
  applyMotionPref();

  const hadLocal = !!localStorage.getItem(STORE_KEY);
  const gotServer = await loadStateFromServer();

  if (!gotServer && serverAvailable && !hadLocal
      && !state.transactions.length && !state.employees.length && !state.projects.length) {
    seedDemo();                       // genuinely first run: server and browser both empty
  } else if (!gotServer && !serverAvailable && !hadLocal
      && !state.transactions.length && !state.employees.length && !state.projects.length) {
    seedDemo();                       // offline first run: local demo so the app isn't empty
  }

  advanceSubscriptions();
  hydrateSettings();
  renderAll();
  setView('overview');
  renderPeriodBar();
  refreshReorderables();

  // if the server was reachable but empty, publish what this device has
  if (serverAvailable && !gotServer) doPush();
}

/* ═══════════════════════════════════════════════════════
   Entry gate

   IMPORTANT, and stated plainly: this PIN is checked in the browser,
   so it keeps casual visitors out — it is not real protection. Anyone
   who opens devtools can read it, and /api/state answers without it.
   It becomes genuine protection the moment a DASHBOARD_PIN environment
   variable is set on the Pages project: the API then rejects requests
   whose X-Dashboard-Pin header does not match, and the PIN stops being
   discoverable from the client. Cloudflare Access remains the stronger
   option because it also covers the endpoints and is per-person.
   ═══════════════════════════════════════════════════════ */
const GATE_PIN = '8127';
const GATE_KEY = 'pl-dashboard:unlocked';

function initGate(onUnlock) {
  const gate = $('#gate');
  if (!gate) { onUnlock(); return; }

  // stay unlocked for the tab session, so a refresh isn't a re-login
  if (sessionStorage.getItem(GATE_KEY) === '1') { onUnlock(); return; }

  gate.hidden = false;
  document.body.classList.add('is-locked');
  const boxes = $$('.pin-box', gate);
  const err = $('#gateError');
  const entered = () => boxes.map((b) => b.value).join('');

  const clearWrong = () => { gate.classList.remove('is-wrong'); err.textContent = ''; };

  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/\D/g, '').slice(0, 1);
      box.classList.toggle('is-filled', !!box.value);
      clearWrong();
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
      if (entered().length === boxes.length) $('#gateForm').requestSubmit();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && i > 0) { boxes[i - 1].focus(); boxes[i - 1].value = ''; boxes[i - 1].classList.remove('is-filled'); }
      if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
      if (e.key === 'ArrowRight' && i < boxes.length - 1) boxes[i + 1].focus();
    });
    // let a pasted code fill the whole row
    box.addEventListener('paste', (e) => {
      const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, boxes.length);
      if (!digits) return;
      e.preventDefault();
      boxes.forEach((b, k) => { b.value = digits[k] || ''; b.classList.toggle('is-filled', !!b.value); });
      clearWrong();
      if (digits.length === boxes.length) $('#gateForm').requestSubmit();
      else boxes[digits.length]?.focus();
    });
  });

  $('#gateForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const pin = entered();
    if (pin.length < boxes.length) { err.textContent = 'Enter all four digits.'; return; }
    if (pin !== GATE_PIN) {
      gate.classList.add('is-wrong');
      err.textContent = 'Incorrect PIN. Try again.';
      setTimeout(() => {
        boxes.forEach((b) => { b.value = ''; b.classList.remove('is-filled'); });
        boxes[0].focus();
      }, 420);
      return;
    }
    sessionStorage.setItem(GATE_KEY, '1');
    apiPin = pin;                       // sent on API calls so server-side checking can be switched on
    gate.classList.add('is-open');
    document.body.classList.remove('is-locked');
    $('.app')?.classList.add('is-revealing');
    setTimeout(() => { gate.hidden = true; gate.classList.remove('is-open'); }, 560);
    onUnlock();
  });

  setTimeout(() => boxes[0].focus(), 380);
}

/** Sent as X-Dashboard-Pin. Ignored by the API until DASHBOARD_PIN is
 *  configured on the Pages project, at which point it becomes required. */
let apiPin = sessionStorage.getItem(GATE_KEY) === '1' ? GATE_PIN : '';

initGate(boot);

// pick up edits made on another device when you come back to this tab
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !serverAvailable || pushing) return;
  try {
    const r = await fetch(STATE_ENDPOINT, { cache: 'no-store', headers: pinHeaders() });
    const d = await r.json();
    if (d.ok && (d.version || 0) > stateVersion && d.state) {
      handleConflict({ ...d, conflict: true });
    }
  } catch { /* stay on the local copy */ }
});
