/* ═══════════════════════════════════════════════════════════
   Shared dashboard state.

   The dashboard used to keep everything in localStorage, which is
   per-browser — that is why the same URL showed different data on
   different machines. State now lives in a Cloudflare KV namespace
   (binding: DASHBOARD_KV) so every device reads and writes the same
   record.

   Concurrency: each save carries the version it was based on. If
   another device has saved since, the write is rejected with 409 and
   the current server copy is returned, so a second device can never
   silently overwrite the first. localStorage is still written on the
   client, but only as an offline cache — the server is authoritative.
   ═══════════════════════════════════════════════════════════ */

const KEY = 'dashboard-state';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export async function onRequestGet({ env }) {
  if (!env.DASHBOARD_KV) return json({ ok: false, error: 'DASHBOARD_KV binding missing' }, 500);
  const raw = await env.DASHBOARD_KV.get(KEY);
  if (!raw) return json({ ok: true, version: 0, state: null });
  try {
    const rec = JSON.parse(raw);
    return json({ ok: true, version: rec.version || 0, updatedAt: rec.updatedAt || null, state: rec.state ?? null });
  } catch {
    return json({ ok: false, error: 'Stored state is not valid JSON' }, 500);
  }
}

export async function onRequestPut({ request, env }) {
  if (!env.DASHBOARD_KV) return json({ ok: false, error: 'DASHBOARD_KV binding missing' }, 500);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Body must be JSON' }, 400); }

  if (!body || typeof body.state !== 'object' || body.state === null) {
    return json({ ok: false, error: 'Missing state object' }, 400);
  }
  // guard against a half-loaded client wiping the record
  if (!Array.isArray(body.state.transactions)) {
    return json({ ok: false, error: 'state.transactions must be an array' }, 400);
  }

  const existingRaw = await env.DASHBOARD_KV.get(KEY);
  let current = { version: 0 };
  if (existingRaw) { try { current = JSON.parse(existingRaw); } catch { /* treat as empty */ } }
  const currentVersion = current.version || 0;
  const base = Number(body.baseVersion);

  // `force` exists so the client can deliberately publish after the user
  // has been shown the conflict and chosen to overwrite
  if (!body.force && Number.isFinite(base) && base !== currentVersion) {
    return json({
      ok: false, conflict: true,
      error: 'This dashboard was updated on another device.',
      version: currentVersion, updatedAt: current.updatedAt || null, state: current.state ?? null,
    }, 409);
  }

  const rec = { version: currentVersion + 1, updatedAt: new Date().toISOString(), state: body.state };
  await env.DASHBOARD_KV.put(KEY, JSON.stringify(rec));
  return json({ ok: true, version: rec.version, updatedAt: rec.updatedAt });
}
