'use strict';
// Name sync (PROTOCOL §12.4a): a Velora account's username / picture is copied into this instance at login, so a rename
// would otherwise only show up the next time that person signs in here. Ask Velora for the current identities of the
// Velora accounts we know (in batches) a minute after boot and every 10 minutes, and apply what changed.
const db = require('../db');
const config = require('../config');
const auth = require('../auth');
const { clean } = require('../util');
const client = require('./client');

const FIRST_MS = 60 * 1000, EVERY_MS = 10 * 60 * 1000, BATCH = 200;
let tick = null, first = null, busy = false;

function apply(list) {
  let changed = 0;
  for (const v of list) {
    if (!v || typeof v.id !== 'string') continue;
    const row = auth.userByPrincipal('v:' + v.id);
    if (!row) continue;
    const un = clean(v.username, 64);
    if (!un) continue;
    const dn = clean(v.display_name, 64) || un, pfp = typeof v.pfp === 'string' && v.pfp ? v.pfp : null;
    if (row.username === un && row.display_name === dn && (row.pfp || null) === pfp) continue;
    db.run('UPDATE users SET username = ?, display_name = ?, pfp = ? WHERE id = ?', un, dn, pfp, row.id);
    auth.identityChanged(auth.userById(row.id), row.username);
    changed++;
  }
  return changed;
}

async function sync() {
  if (busy || !client.registered() || config.mode() !== 'velora') return 0;
  busy = true;
  let changed = 0;
  try {
    const ids = db.all("SELECT velora_id FROM users WHERE kind = 'velora' AND velora_id IS NOT NULL").map(r => r.velora_id);
    for (let i = 0; i < ids.length; i += BATCH) {
      const r = await client.call('POST', '/bonfire/relay/identities', { ids: ids.slice(i, i + BATCH) });
      changed += apply(Array.isArray(r?.users) ? r.users : []);
    }
  } catch { /* Velora unreachable or too old for this route: the next round tries again */ } finally { busy = false; }
  return changed;
}

function start() {
  first = setTimeout(() => { sync(); }, FIRST_MS); first.unref?.();
  tick = setInterval(() => { sync(); }, EVERY_MS); tick.unref?.();
}
function stop() { clearTimeout(first); clearInterval(tick); first = tick = null; }
module.exports = { start, stop, sync, apply };
