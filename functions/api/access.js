/* ═══════════════════════════════════════════════════════════
   Access configuration — lets an editor change either PIN from the
   dashboard itself, with no redeploy and nothing to edit by hand in
   Cloudflare.

   Only the SHA-256 hash of each PIN is ever stored, so reading the KV
   record does not reveal a PIN. Changing a PIN requires the current
   editor PIN, so a viewer cannot promote themselves.
   ═══════════════════════════════════════════════════════════ */

const ACCESS_KEY = 'access-config';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readCfg(env) {
  const raw = await env.DASHBOARD_KV.get(ACCESS_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/** True only for the current editor PIN. */
async function isEditor(request, env) {
  const cfg = await readCfg(env);
  if (!cfg || !cfg.editHash) return true;          // unconfigured ⇒ open, matches state.js
  const pin = request.headers.get('X-Dashboard-Pin') || '';
  if (!pin) return false;
  return (await sha256Hex(pin)) === cfg.editHash;
}

/** Reports which PINs are configured — never the PINs themselves. */
export async function onRequestGet({ request, env }) {
  if (!env.DASHBOARD_KV) return json({ ok: false, error: 'DASHBOARD_KV binding missing' }, 500);
  if (!(await isEditor(request, env))) return json({ ok: false, error: 'Editor access required' }, 403);
  const cfg = (await readCfg(env)) || {};
  return json({ ok: true, hasEdit: !!cfg.editHash, hasView: !!cfg.viewHash, updatedAt: cfg.updatedAt || null });
}

export async function onRequestPost({ request, env }) {
  if (!env.DASHBOARD_KV) return json({ ok: false, error: 'DASHBOARD_KV binding missing' }, 500);
  if (!(await isEditor(request, env))) return json({ ok: false, error: 'Editor access required' }, 403);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Body must be JSON' }, 400); }

  const { editPin, viewPin } = body || {};
  const valid = (p) => typeof p === 'string' && /^\d{4}$/.test(p);
  if (editPin !== undefined && !valid(editPin)) return json({ ok: false, error: 'Editor PIN must be 4 digits' }, 400);
  if (viewPin !== undefined && !valid(viewPin)) return json({ ok: false, error: 'Viewer PIN must be 4 digits' }, 400);
  if (editPin === undefined && viewPin === undefined) return json({ ok: false, error: 'Nothing to change' }, 400);

  const cfg = (await readCfg(env)) || {};
  if (editPin !== undefined) cfg.editHash = await sha256Hex(editPin);
  if (viewPin !== undefined) cfg.viewHash = await sha256Hex(viewPin);

  // identical PINs would make the viewer role unreachable — the editor
  // check runs first, so everyone would silently get write access
  if (cfg.editHash && cfg.viewHash && cfg.editHash === cfg.viewHash) {
    return json({ ok: false, error: 'The two PINs must be different.' }, 400);
  }

  cfg.updatedAt = new Date().toISOString();
  await env.DASHBOARD_KV.put(ACCESS_KEY, JSON.stringify(cfg));
  return json({ ok: true, changed: { editor: editPin !== undefined, viewer: viewPin !== undefined } });
}
