'use strict';
// Keeps the names / pictures of Velora-account members current. Sessions can outlive the login token's claims, so an account that
// renamed itself on Velora would otherwise stay "old_name" here until its next sign-in. Source: VELORA/bonfire/profiles?ids=1,2,3
// (public, cached 60 s). A change goes through auth.refreshVeloraProfile -> identityChanged -> chat_identity_update to clients.
//   - lazily on every gateway chat_hello (at most once per account per 10 minutes)
//   - periodically (every 15 min, rotating through up to 500 members per run)
const config = require('./config');
const db = require('./db');
const auth = require('./auth');

const TTL = 10 * 60 * 1000, CYCLE = 15 * 60 * 1000, PER_CYCLE = 500, BATCH = 100;
const checked = new Map(); // velora id -> ms
let offset = 0, timer = null;

const enabled = () => config.mode() === 'velora' && config.get().velora_registration !== 'off' && process.env.BONFIRE_PROFILE_SYNC !== '0';

async function fetchProfiles(ids) {
  const r = await fetch(`${config.get().velora_url}/bonfire/profiles?ids=${ids.join(',')}`, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('status ' + r.status);
  const j = await r.json();
  return Array.isArray(j?.profiles) ? j.profiles : [];
}

// -> number of accounts that changed. Never throws (Velora being down must not hurt anything).
async function refresh(veloraIds, { force = false } = {}) {
  if (!enabled()) return 0;
  const now = Date.now();
  const ids = [...new Set(veloraIds.map(String))].filter(id => /^[1-9]\d{0,19}$/.test(id) && (force || now - (checked.get(id) || 0) > TTL));
  let changed = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const part = ids.slice(i, i + BATCH);
    try {
      for (const p of await fetchProfiles(part)) {
        if (p && typeof p.username === 'string' && auth.refreshVeloraProfile({ id: String(p.id), username: p.username, display_name: p.display_name, pfp: typeof p.pfp === 'string' ? p.pfp : null })) changed++;
      }
      for (const id of part) checked.set(id, now);
    } catch { /* fail silent; retried next time */ }
  }
  if (checked.size > 20000) for (const [k, t] of checked) if (now - t > TTL) checked.delete(k);
  return changed;
}

const lazy = user => { if (user?.kind === 'velora' && user.velora_id) refresh([user.velora_id]).catch(() => {}); };

async function cycle() {
  try {
    const rows = db.all("SELECT DISTINCT u.velora_id FROM users u JOIN members m ON m.user_id = u.id WHERE u.kind = 'velora' AND u.velora_id IS NOT NULL ORDER BY u.id LIMIT ? OFFSET ?", PER_CYCLE, offset);
    offset = rows.length < PER_CYCLE ? 0 : offset + PER_CYCLE;
    await refresh(rows.map(r => r.velora_id), { force: true });
  } catch { /* db closed / not ready */ }
}
const start = () => { if (timer) return; timer = setInterval(cycle, CYCLE); timer.unref(); setTimeout(cycle, 45000).unref(); };
const stop = () => { if (timer) clearInterval(timer); timer = null; };

module.exports = { refresh, lazy, start, stop };
