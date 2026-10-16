'use strict';
// Mentions: who a message pings, and delivery. Online members get a `chat_mention` gateway event; everyone else goes through
// notifyOffline(userIds, payload), the single extension point for push (a later wave replaces it; it is a no-op here).
// Preferences (/notify levels + mute) come from the `notify` table: the channel's setting, else the community's, else mentions only.
const db = require('./db');
const gateway = require('./gateway');

let offline = () => {};
const setOfflineHandler = fn => { offline = typeof fn === 'function' ? fn : () => {}; };
// notifyOffline(userIds: number[], payload: the chat_mention object)
const notifyOffline = (userIds, payload) => { try { return offline(userIds, payload); } catch (e) { console.error('[notify] offline hook', e.message); } };

function effective(prefs, sid, cid) {
  const sv = prefs.get(sid) || {}, ch = prefs.get(cid) || {}, t = Date.now();
  const muted = (ch.muted_until && ch.muted_until > t) || (sv.muted_until && sv.muted_until > t);
  const level = ch.level && ch.level !== 'default' ? ch.level : (sv.level && sv.level !== 'default' ? sv.level : 'mentions');
  return { muted: !!muted, level, push: ch.push !== false && sv.push !== false };
}

// msg = the message view; ctx = { ch, c, snap }. Called for ordinary posts (not system / webhook / bridged).
function deliver(ctx, msg, authorId) {
  const { ch, c, snap } = ctx;
  const body = String(msg.body || '');
  const names = new Set((body.match(/(^|[\s(])@([A-Za-z0-9_.-]{2,32})/g) || []).map(x => x.trim().replace(/^\(?@/, '').toLowerCase()));
  const prefs = new Map();
  for (const r of db.all('SELECT user_id, target, level, muted_until, push FROM notify WHERE target IN (?, ?)', c.sid, ch.cid)) {
    if (!prefs.has(r.user_id)) prefs.set(r.user_id, new Map());
    prefs.get(r.user_id).set(r.target, { level: r.level, muted_until: r.muted_until, push: !!r.push });
  }
  const online = new Set(gateway.onlineUserIds());
  const payload = { type: 'chat_mention', id: msg.id, server: c.name, sid: c.sid, channel: ch.name, cid: ch.cid, from: msg.author?.username, pfp: msg.author?.pfp || null, body: body || 'sent a picture' };
  const off = [];
  for (const u of db.all("SELECT u.* FROM users u JOIN members m ON m.user_id = u.id WHERE m.community_id = ? AND u.kind <> 'bot'", c.id)) {
    if (u.id === Number(authorId) || !snap.canView(ch, u.id)) continue;
    const n = effective(prefs.get(u.id) || new Map(), c.sid, ch.cid);
    if (n.muted || n.level === 'none') continue;
    const isOn = online.has(u.id);
    let hit = n.level === 'all' || msg.mention_everyone === 'everyone' || (msg.mention_everyone === 'here' && isOn) || (msg.reply?.author?.id && msg.reply.author.id === u.principal);
    if (!hit && msg.mention_roles?.length) { const ids = snap.roleIds(u.id); hit = snap.roles.some(r => ids.has(r.id) && msg.mention_roles.includes(r.rid)); }
    if (!hit && names.size) hit = names.has(String(u.username).toLowerCase());
    if (!hit) continue;
    if (isOn) gateway.pushToUser(u.id, payload);
    else if (n.push) off.push(u.id);
  }
  if (off.length) notifyOffline(off, payload);
}

module.exports = { effective, deliver, notifyOffline, setOfflineHandler };
