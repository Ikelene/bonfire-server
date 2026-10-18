'use strict';
// The public Bonfire directory on Velora (PROTOCOL §12.9): PUT /bonfire/relay/directory while the instance setting `listed`
// (= the community's `listed`) is on; `listed: false` takes the listing down. Re-pushed (debounced) whenever what would be
// listed changes, and every 6 hours anyway.
const db = require('../db');
const config = require('../config');
const C = require('../communities');
const client = require('./client');

const CHECK_MS = 60 * 1000, FORCE_MS = 6 * 3600 * 1000;
let DEBOUNCE_MS = 3000;
let tick = null, soon = null, busy = false, info = { listed: false, hidden_by_staff: false, pushed_at: null, last_error: null };

const abs = u => { try { return u ? new URL(u, config.publicUrl()).href : null; } catch { return null; } };
function payload() {
  const c = db.get('SELECT * FROM communities ORDER BY id LIMIT 1');
  if (!c || !c.listed) return { listed: false };
  const cfg = config.get(), origin = cfg.public_url;
  return {
    listed: true, name: c.name, description: c.description || '', icon_url: abs(c.icon_url), member_count: C.memberCount(c.id),
    // the community's permanent invite, opened in Bonfire on the web
    invite_url: `${cfg.velora_url}/chat#/i/${encodeURIComponent(origin)}/invite/${c.invite_code}`,
    tags: Array.isArray(cfg.tags) ? cfg.tags.slice(0, 8) : [],
  };
}
const last = () => { try { return JSON.parse(db.metaGet('velora_dir') || 'null'); } catch { return null; } };

async function push(force = false) {
  if (busy || !client.registered()) return null;
  const p = payload(), fp = JSON.stringify(p), prev = last();
  if (!force && prev?.fp === fp && Date.now() - prev.at < FORCE_MS) return null;
  if (!p.listed && !prev?.listed) return null; // never listed: nothing to take down
  busy = true;
  try {
    let body = { ...p }, out;
    for (let i = 0; i < 3; i++) { // Velora only stores https links: drop a link it refuses rather than the whole listing
      try { out = await client.call('PUT', '/bonfire/relay/directory', body); break; } catch (e) {
        if (e.code === 'invalid_icon_url' && body.icon_url) { body.icon_url = null; continue; }
        if (e.code === 'invalid_invite_url' && body.invite_url) { body.invite_url = null; continue; }
        throw e;
      }
    }
    db.metaSet('velora_dir', JSON.stringify({ fp, at: Date.now(), listed: p.listed }));
    info = { listed: !!out?.listed, hidden_by_staff: !!out?.hidden_by_staff, pushed_at: Date.now(), last_error: null };
    return out;
  } catch (e) { info.last_error = e.code || e.message; return null; } finally { busy = false; }
}
function poke() { clearTimeout(soon); soon = setTimeout(() => { push().catch(() => {}); }, DEBOUNCE_MS); soon.unref?.(); }
const onRegistered = () => poke();

function start() {
  tick = setInterval(() => { push().catch(() => {}); }, CHECK_MS); tick.unref?.();
  config.events.on('change', poke);
  client.events.on('registered', onRegistered);
}
function stop() { clearInterval(tick); clearTimeout(soon); tick = soon = null; config.events.off('change', poke); info = { listed: false, hidden_by_staff: false, pushed_at: null, last_error: null }; }
// (after a restart, until the next push: what the last push stored)
const status = () => (info.pushed_at || !client.registered() ? { ...info } : { ...info, listed: !!last()?.listed, pushed_at: last()?.at || null });
module.exports = { start, stop, push, poke, payload, status, _setDebounce: ms => { DEBOUNCE_MS = ms; } };
