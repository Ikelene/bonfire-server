'use strict';
// One-click "Update server" for an instance that runs in a Docker container which something else (bonfire-hostd) can rebuild and
// recreate. The instance never touches Docker itself: it asks the host agent over HTTP.
//   BONFIRE_UPDATE_URL     base URL of bonfire-hostd's API as seen from this container, e.g. http://172.17.0.1:8090
//   BONFIRE_UPDATE_SECRET  bearer secret for it (HOSTD_SECRET, or the narrower HOSTD_CHAT_UPDATE_SECRET); never sent to clients
// Not configured, or a Velora-hosted (managed) instance (those are updated by the host's update-all): reported as unsupported.
const managed = require('./managed');
const { err, log } = require('./util');

const GET_TIMEOUT = 6000, POST_TIMEOUT = 15000;
const url = () => {
  const raw = String(process.env.BONFIRE_UPDATE_URL || '').trim();
  if (!raw) return null;
  try { const u = new URL(raw); return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin + u.pathname.replace(/\/+$/, '') : null; } catch { return null; }
};
const secret = () => String(process.env.BONFIRE_UPDATE_SECRET || '');
function support() {
  if (managed.active()) return { supported: false, reason: 'managed' };
  if (!url() || !secret()) return { supported: false, reason: 'not_configured' };
  return { supported: true };
}
function currentBuild() {
  let V = null;
  try { V = require('./version'); } catch { /* checkout without build identity */ }
  const pkg = require('../package.json');
  return V ? V.build() : { version: pkg.version, commit: null, commit_short: null, commit_date: null, built_at: null, dirty: false, build_id: null };
}

// ask hostd; every failure becomes a stable error code, the secret and the host's own messages never reach the client
async function hostd(method, timeout) {
  let r;
  try {
    r = await fetch(`${url()}/chat-update`, { method, headers: { Authorization: 'Bearer ' + secret(), Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, body: method === 'POST' ? '{}' : undefined, signal: AbortSignal.timeout(timeout) });
  } catch (e) { log(`[update] update service unreachable: ${e.name === 'TimeoutError' ? 'timeout' : e.code || e.cause?.code || e.message}`); throw err('update_service_unreachable', 502); }
  let body = null;
  try { body = await r.json(); } catch { /* not json */ }
  if (r.status === 409) throw err('update_in_progress', 409);
  if (r.status === 401 || r.status === 403) { log(`[update] update service rejected our credentials (${r.status})`); throw err('update_service_rejected', 502); }
  if (!r.ok || !body || typeof body !== 'object') { log(`[update] update service answered ${r.status}`); throw err('update_service_error', 502); }
  return body;
}
const str = (v, n = 80) => (typeof v === 'string' ? v.slice(0, n) : null);
const buildView = b => (b && typeof b === 'object' ? { version: str(b.version), commit: str(b.commit), commit_short: str(b.commit_short) || (str(b.commit) || '').slice(0, 7) || null, commit_date: str(b.commit_date), built_at: str(b.built_at), build_id: str(b.build_id), message: str(b.message, 200) } : null);
function updateView(u) {
  if (!u || typeof u !== 'object') return null;
  return { state: ['idle', 'running', 'done', 'failed'].includes(u.state) ? u.state : 'idle', step: str(u.step, 30), started_at: str(u.started_at, 40), finished_at: str(u.finished_at, 40), output: str(u.output, 4000) };
}

function register(app) {
  app.get('/api/v1/instance/update', { admin: true }, async () => {
    const out = { ...support(), current: currentBuild() };
    if (!out.supported) return out;
    try {
      const h = await hostd('GET', GET_TIMEOUT);
      out.reachable = true;
      out.latest = buildView(h.latest);
      out.outdated = typeof h.outdated === 'boolean' ? h.outdated : typeof h.image_current === 'boolean' ? !h.image_current : null; // is the running container behind the newest build?
      out.running = buildView(h.running);
      out.update = updateView(h.update);
    } catch (e) { out.reachable = false; out.error = e.code || 'update_service_error'; }
    return out;
  });
  app.post('/api/v1/instance/update', { admin: true }, async req => {
    const s = support();
    if (!s.supported) throw err(s.reason === 'managed' ? 'update_managed' : 'update_not_supported', 501);
    log(`[instance] update requested by ${req.user.principal}`);
    const h = await hostd('POST', POST_TIMEOUT);
    return { ok: true, update: updateView(h.update) || { state: 'running' } };
  });
}
module.exports = { register, support };
