'use strict';
// Starboards (channel type `starboard`): the community's best messages. Stars are the ⭐ reaction (the star button, the reaction and
// votes in the board are all the same thing). The board's config says which channels it watches (none = every chat channel) and how
// many stars a message needs. Once a message is on a board it stays, even if it loses stars (only deleting it, or its channel, removes it).
const db = require('./db');
const gateway = require('./gateway');
const C = require('./communities');
const { err } = require('./util');

const STAR = '⭐';
const M = () => require('./messages');
const minOf = ch => Math.min(Math.max(Math.trunc(Number(C.cfgOf(ch).min) || 3), 1), 100);
const watches = (board, ch) => {
  if (ch.id === board.id || ch.type === 'starboard') return false;
  const w = C.cfgOf(board).watch || [];
  return w.length ? w.includes(ch.cid) : ['text', 'welcome', 'logs'].includes(ch.type || 'text');
};

// a message's star count changed (called from messages.react); ctx = { ch, c, snap }
function onStar({ ch, c, snap }, messageId, count) {
  for (const b of snap.channels.filter(x => x.type === 'starboard' && watches(x, ch))) {
    const base = { type: 'chat_starboard', server: c.sid, channel: b.cid, id: String(messageId), stars: count };
    if (db.get('SELECT 1 FROM starboard WHERE board_id = ? AND message_id = ?', b.id, messageId)) { gateway.emit(c.id, base); continue; }
    if (count < minOf(b)) continue;
    if (db.run('INSERT OR IGNORE INTO starboard (board_id, message_id, starred_at) VALUES (?, ?, ?)', b.id, messageId, Date.now()).changes) gateway.emit(c.id, { ...base, added: true });
  }
}

// one board's posts as the viewer may see them (only from channels they can see)
function entryViews(board, snap, me, rows) {
  if (!rows.length) return [];
  const { SELECT_MSG, messageView, withReactions } = M();
  const ids = rows.map(r => r.message_id);
  const byId = new Map(db.all(`${SELECT_MSG} WHERE m.id IN (${db.inList(ids)})`, ...ids).map(r => [r.id, r]));
  const out = [];
  for (const r of rows) {
    const m = byId.get(r.message_id), ch = m && snap.channel(m.channel_id);
    if (!ch || !snap.canView(ch, me.id)) continue;
    out.push({ ...messageView(m, snap), channel_name: ch.name, starred_at: r.starred_at });
  }
  withReactions(out);
  for (const v of out) v.stars = (v.reactions || []).find(x => x.emoji === STAR)?.count || 0;
  const mine = out.length ? new Set(db.all(`SELECT message_id FROM reactions WHERE user_id = ? AND emoji = ? AND message_id IN (${db.inList(out)})`, me.id, STAR, ...out.map(v => Number(v.id))).map(x => String(x.message_id))) : new Set();
  for (const v of out) v.starred = mine.has(String(v.id));
  return out;
}

// GET a board: the newest posts (paged by ?before=<starred_at>), the most-starred ones and a random throwback
function view(cid, me, { before } = {}) {
  const { ch: board, snap } = C.findChannel(cid, me);
  if (board.type !== 'starboard') throw err('not_a_starboard');
  const limit = 30, b4 = Number(before) || 0;
  const recentRows = db.all(`SELECT message_id, starred_at FROM starboard WHERE board_id = ?${b4 ? ' AND starred_at < ?' : ''} ORDER BY starred_at DESC, message_id DESC LIMIT ${limit + 1}`, ...(b4 ? [board.id, b4] : [board.id]));
  const more = recentRows.length > limit;
  const recent = entryViews(board, snap, me, recentRows.slice(0, limit));
  if (b4) return { recent, more };
  const topRows = db.all(`SELECT s.message_id, s.starred_at, COUNT(r.user_id) AS n FROM starboard s LEFT JOIN reactions r ON r.message_id = s.message_id AND r.emoji = ?
    WHERE s.board_id = ? GROUP BY s.message_id, s.starred_at ORDER BY n DESC, s.starred_at DESC LIMIT 8`, STAR, board.id);
  const top = entryViews(board, snap, me, topRows).slice(0, 5);
  const total = db.get('SELECT COUNT(*) AS n FROM starboard WHERE board_id = ?', board.id).n;
  let throwback = null; // something starred a while ago (older than a day when there is enough), at random
  for (let tries = 0; tries < 4 && !throwback && total; tries++) {
    const old = total > 10 && tries < 2;
    const pick = db.get(`SELECT message_id, starred_at FROM starboard WHERE board_id = ?${old ? ' AND starred_at < ?' : ''} ORDER BY RANDOM() LIMIT 1`, ...(old ? [board.id, Date.now() - 86400000] : [board.id]));
    if (pick) throwback = entryViews(board, snap, me, [pick])[0] || null;
  }
  const watching = (C.cfgOf(board).watch || []).map(x => snap.channels.find(k => k.cid === x)).filter(k => k && snap.canView(k, me.id)).map(k => k.name);
  return { recent, more, top, throwback, total, min: minOf(board), watching };
}

module.exports = { STAR, onStar, view };
