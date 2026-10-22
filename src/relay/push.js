'use strict';
// Offline push through Velora (PROTOCOL §12.3): notify.notifyOffline -> POST /bonfire/relay/notify, Velora principals only.
// Coalesced per user + channel: the first ping goes out at once, later ones in the next WINDOW become one summary push.
// Nobody who is connected to this instance is pushed (Velora also holds pushes while the person is using Ember).
const db = require('../db');
const config = require('../config');
const gateway = require('../gateway');
const notify = require('../notify');
const client = require('./client');

let WINDOW = 30 * 1000;
const slots = new Map(); // `${userId}:${cid}` -> { until, count, last, timer }
const trim = (s, n) => { const a = [...String(s ?? '').replace(/\s+/g, ' ').trim()]; return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };

function kindOf(u, payload) {
  const m = db.get('SELECT r.user_id AS ru FROM messages m LEFT JOIN messages r ON r.id = m.reply_to WHERE m.id = ?', Number(payload.id));
  return m?.ru === u.id ? 'reply' : 'mention';
}
function body(u, payload, count) {
  const kind = kindOf(u, payload), from = payload.from || 'Someone';
  const title = count > 1 ? `${count} new mentions in #${payload.channel}` : kind === 'reply' ? `${from} replied to you` : `${from} mentioned you`;
  return {
    user_id: String(u.velora_id), kind, community_name: trim(payload.server, 80), channel_name: trim(payload.channel, 80),
    title: trim(title, 100), preview: trim(count > 1 ? `${from}: ${payload.body}` : payload.body, 300),
    // on the instance's own origin (Velora requires it); the fragment is the client's route for this channel
    url: `${config.publicUrl()}/#/s/${payload.sid}/${payload.cid}`,
  };
}
async function send(u, payload, count) {
  if (!client.registered() || gateway.isOnline(u.id)) return null;
  try { return await client.call('POST', '/bonfire/relay/notify', body(u, payload, count)); } catch (e) {
    if (e.status !== 429 && e.code !== 'velora_unreachable') console.error('[velora] push failed:', e.code || e.message);
    return null;
  }
}

function onOffline(userIds, payload) {
  if (!client.registered() || !payload?.cid) return;
  const t = Date.now();
  for (const id of userIds) {
    const u = db.get("SELECT * FROM users WHERE id = ? AND kind = 'velora'", Number(id));
    if (!u?.velora_id || gateway.isOnline(u.id)) continue;
    const k = `${u.id}:${payload.cid}`;
    const s = slots.get(k);
    if (s && s.until > t) { s.count++; s.last = payload; continue; }
    const slot = { until: t + WINDOW, count: 0, last: payload, timer: null };
    slot.timer = setTimeout(() => {
      if (slots.get(k) === slot) slots.delete(k);
      if (slot.count) send(u, slot.last, slot.count); // the pings held back in the window, as one push
    }, WINDOW);
    slot.timer.unref?.();
    slots.set(k, slot);
    send(u, payload, 1);
  }
}

function start() { notify.setOfflineHandler(onOffline); }
function stop() { notify.setOfflineHandler(null); for (const s of slots.values()) clearTimeout(s.timer); slots.clear(); }
module.exports = { start, stop, onOffline, _setWindow: ms => { WINDOW = ms; } };
