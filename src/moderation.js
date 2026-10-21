'use strict';
// Moderation: AutoMod (blocked words + spam limits), timeouts and reports.
//  - AutoMod runs on every message a person or bot posts or edits (messages.js postMessage / editMessage). A blocked word refuses the
//    message (`automod_blocked`) and can time the sender out; going over the spam limits refuses it (`slow_down`) and can pause them.
//  - A timeout stops someone posting in the community until it runs out (`timed_out`). AutoMod sets them; moderators can lift them.
//  - Reports: anyone in the community can report a message or a member; people with Kick, Ban, Manage messages or Manage server
//    see the queue (Server settings > Reports) and resolve or dismiss each one.
const db = require('./db');
const auth = require('./auth');
const gateway = require('./gateway');
const S = require('./settings');
const audit = require('./audit');
const { P } = require('./perms');
const { err, now, clean, limiter } = require('./util');

// ---------- timeouts ----------
function timeoutUntil(c, userId) {
  const r = db.get('SELECT until FROM timeouts WHERE community_id = ? AND user_id = ?', c.id, userId);
  if (!r) return null;
  if (r.until <= now()) { db.run('DELETE FROM timeouts WHERE community_id = ? AND user_id = ?', c.id, userId); return null; }
  return r.until;
}
// replace: a moderator's timeout sets the end (shorter or longer); AutoMod's only ever makes one longer
function timeOut(c, userId, seconds, reason, { replace = false } = {}) {
  const until = now() + seconds * 1000;
  db.run(`INSERT INTO timeouts (community_id, user_id, until, reason) VALUES (?, ?, ?, ?) ON CONFLICT(community_id, user_id) DO UPDATE SET until = ${replace ? 'excluded.until' : 'MAX(until, excluded.until)'}, reason = excluded.reason`, c.id, userId, until, clean(reason, 200));
  const end = timeoutUntil(c, userId) || until;
  gateway.pushToUser(userId, { type: 'chat_timeout', server: c.sid, until: end, reason: clean(reason, 200) || null });
  require('./voice').removeMember(userId, c.id, 'timed_out'); // (no voice while timed out)
  require('./communities').memberChanged(c, userId, 'role'); // (member lists show the timeout)
  return end;
}
const MAX_TIMEOUT = 28 * 86400;
// a moderator (Kick or Ban) times someone out: body { user_id, seconds (1 .. 28 days), reason? }
function timeOutBy(sid, me, body = {}) {
  const C = require('./communities');
  const { c, snap } = C.memberCommunity(sid, me);
  if (!snap.can(me.id, P.KICK) && !snap.can(me.id, P.BAN)) throw err('not_allowed', 403);
  const t = C.userByPrincipalOrThrow(body.user_id);
  if (Number(t.id) === Number(me.id) || !snap.isMember(t.id) || snap.isOwner(t.id)) throw err('not_allowed', 403);
  if (!snap.isOwner(me.id) && snap.top(t.id) >= snap.top(me.id)) throw err('not_allowed', 403);
  const secs = Number(body.seconds);
  if (!Number.isInteger(secs) || secs < 1 || secs > MAX_TIMEOUT) throw err('invalid_timeout');
  const until = timeOut(c, t.id, secs, body.reason || '', { replace: true });
  audit.record(c, me, 'member_timeout', { target: { kind: 'user', id: t.principal, name: t.username }, details: { seconds: secs, ...(clean(body.reason, 200) ? { reason: clean(body.reason, 200) } : {}) } });
  return { until };
}
function liftTimeout(sid, me, targetPrincipal) {
  const C = require('./communities');
  const { c, snap } = C.memberCommunity(sid, me);
  if (!snap.can(me.id, P.KICK) && !snap.can(me.id, P.BAN)) throw err('not_allowed', 403);
  const t = C.userByPrincipalOrThrow(targetPrincipal);
  if (!db.run('DELETE FROM timeouts WHERE community_id = ? AND user_id = ?', c.id, t.id).changes) return;
  gateway.pushToUser(t.id, { type: 'chat_timeout', server: c.sid, until: null });
  C.memberChanged(c, t.id, 'role');
  audit.record(c, me, 'timeout_remove', { target: { kind: 'user', id: t.principal, name: t.username } });
}
function listTimeouts(sid, me) {
  const C = require('./communities');
  const { c, snap } = C.memberCommunity(sid, me);
  if (!snap.can(me.id, P.KICK) && !snap.can(me.id, P.BAN)) throw err('not_allowed', 403);
  return { timeouts: db.all('SELECT * FROM timeouts WHERE community_id = ? AND until > ? ORDER BY until', c.id, now()).map(r => ({ user: auth.userView(auth.userById(r.user_id)), until: r.until, reason: r.reason })) };
}

// ---------- AutoMod ----------
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let reCache = { key: null, re: null };
function wordRegex(a, words) {
  const key = JSON.stringify([words, a.whole_word, a.match_case]);
  if (reCache.key === key) return reCache.re;
  const list = [...new Set(words.map(w => w.trim()).filter(Boolean))].sort((x, y) => y.length - x.length).map(escRe);
  const re = list.length ? new RegExp(a.whole_word ? `(?<![\\p{L}\\p{N}_])(?:${list.join('|')})(?![\\p{L}\\p{N}_])` : `(?:${list.join('|')})`, a.match_case ? 'u' : 'iu') : null;
  reCache = { key, re };
  return re;
}
const exemptRoles = (snap, me, a) => {
  if (!a.exempt_roles.length) return false;
  const mine = snap.roleIds(me.id);
  return snap.roles.some(r => a.exempt_roles.includes(r.rid) && mine.has(r.id));
};
// the blocked word in `text` (or null)
function blockedWord(c, text) {
  const a = S.get(c).automod;
  if (!a.words_enabled) return null;
  const re = wordRegex(a, [...a.words, ...S.fileWords(a.word_file)]);
  const m = re && re.exec(String(text || ''));
  return m ? m[0] : null;
}
const spam = new Map(); // `${community}:${user}` -> [timestamps]
let lastSweep = now();
function spamHit(c, me, s) {
  const t = now(), key = `${c.sid}:${me.id}`;
  if (t - lastSweep > 60000) { lastSweep = t; for (const [k, v] of spam) if (!v.length || t - v[v.length - 1] > 60000) spam.delete(k); }
  const list = (spam.get(key) || []).filter(x => t - x < 60000);
  const burst = list.filter(x => t - x < 10000).length;
  if (list.length >= s.per_minute || burst >= s.burst) { spam.set(key, list); return false; }
  list.push(t); spam.set(key, list);
  return true;
}

// before a message is posted / edited by a person or bot. ctx = { ch, c, snap }. Throws timed_out / automod_blocked / slow_down.
function beforePost(ctx, me, body, { edit = false } = {}) {
  const { c, ch, snap } = ctx;
  if (snap.isOwner(me.id)) return;
  const until = timeoutUntil(c, me.id);
  if (until) throw err('timed_out', 403, { until });
  const s = S.get(c), a = s.automod;
  if (exemptRoles(snap, me, a)) return;
  const word = blockedWord(c, body);
  if (word) {
    const secs = a.timeout_seconds;
    const until2 = secs > 0 ? timeOut(c, me.id, secs, 'AutoMod: blocked word') : null;
    audit.record(c, null, 'automod_block', { target: { kind: 'user', id: me.principal, name: me.username }, details: { channel: ch.name, timeout_seconds: secs || 0, edit } });
    throw err('automod_blocked', 403, { until: until2 });
  }
  if (!edit && a.spam_enabled && !snap.can(me.id, P.MANAGE_MESSAGES) && !spamHit(c, me, s.spam)) {
    const secs = s.spam.pause_seconds;
    let until2 = null;
    if (secs > 0) {
      until2 = timeOut(c, me.id, secs, 'AutoMod: posting too fast');
      audit.record(c, null, 'spam_pause', { target: { kind: 'user', id: me.principal, name: me.username }, details: { channel: ch.name, pause_seconds: secs } });
    }
    throw err('slow_down', 429, { until: until2 });
  }
}

// ---------- reports ----------
const reportLimit = limiter(10, 10 * 60 * 1000);
const isModerator = (snap, uid) => snap.can(uid, P.KICK) || snap.can(uid, P.BAN) || snap.can(uid, P.MANAGE_MESSAGES) || snap.can(uid, P.MANAGE_SERVER);
const json = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
function reportView(r, snap) {
  const u = id => (id == null ? null : auth.userView(auth.userById(id)));
  const snapMsg = json(r.snapshot);
  const ch = r.channel_id ? snap.channels.find(x => x.id === r.channel_id) : null;
  return {
    id: String(r.id), kind: r.kind, status: r.status, reason: r.reason, created_at: r.created_at,
    reporter: u(r.reporter_id), target: u(r.target_user_id),
    message: r.kind === 'message' ? { id: String(r.message_id), channel: ch?.cid || null, channel_name: ch?.name || snapMsg?.channel_name || null, body: snapMsg?.body ?? '', attachments: snapMsg?.attachments || 0, author_name: snapMsg?.author_name || null, exists: !!db.get('SELECT 1 FROM messages WHERE id = ?', r.message_id) } : null,
    resolved_by: u(r.resolved_by), resolved_at: r.resolved_at || null, note: r.note || '',
  };
}
function createReport(sid, me, body = {}) {
  const C = require('./communities');
  const { c, snap } = C.memberCommunity(sid, me);
  if (!reportLimit.hit(me.id)) throw err('rate_limited', 429);
  const reason = clean(body.reason, 500);
  let row;
  if (body.message_id != null) {
    const id = String(body.message_id);
    if (!/^\d{1,15}$/.test(id)) throw err('message_not_found', 404);
    const m = db.get('SELECT * FROM messages WHERE id = ?', Number(id));
    const ch = m && snap.channels.find(x => x.id === m.channel_id);
    if (!ch || !snap.canView(ch, me.id) || m.system) throw err('message_not_found', 404);
    if (m.user_id != null && Number(m.user_id) === Number(me.id)) throw err('cannot_report_yourself');
    const open = db.get("SELECT id FROM reports WHERE community_id = ? AND reporter_id = ? AND message_id = ? AND status = 'open'", c.id, me.id, m.id);
    if (open) return { report: { id: String(open.id) }, duplicate: true };
    const author = m.user_id ? auth.userById(m.user_id) : null;
    const shot = { body: String(m.body || '').slice(0, 2000), attachments: (json(m.attachments) || []).length, channel_name: ch.name, author_name: author?.username || m.author_name || null };
    const r = db.run('INSERT INTO reports (community_id, kind, reporter_id, target_user_id, message_id, channel_id, snapshot, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      c.id, 'message', me.id, author?.id ?? null, m.id, ch.id, JSON.stringify(shot), reason, now());
    row = db.get('SELECT * FROM reports WHERE id = ?', r.lastInsertRowid);
  } else if (body.user_id != null) {
    const t = C.userByPrincipalOrThrow(body.user_id);
    if (Number(t.id) === Number(me.id)) throw err('cannot_report_yourself');
    if (!snap.isMember(t.id)) throw err('not_a_member', 404);
    const open = db.get("SELECT id FROM reports WHERE community_id = ? AND reporter_id = ? AND kind = 'member' AND target_user_id = ? AND status = 'open'", c.id, me.id, t.id);
    if (open) return { report: { id: String(open.id) }, duplicate: true };
    const r = db.run('INSERT INTO reports (community_id, kind, reporter_id, target_user_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)', c.id, 'member', me.id, t.id, reason, now());
    row = db.get('SELECT * FROM reports WHERE id = ?', r.lastInsertRowid);
  } else throw err('nothing_to_report');
  const view = reportView(row, snap);
  gateway.emitWhere(c.id, { type: 'chat_report', server: c.sid, report: view, open: openCount(c) }, uid => isModerator(snap, uid));
  return { report: { id: view.id } };
}
const openCount = c => db.get("SELECT COUNT(*) AS n FROM reports WHERE community_id = ? AND status = 'open'", c.id).n;
function reportAccess(sid, me) {
  const { c, snap } = require('./communities').memberCommunity(sid, me);
  if (!isModerator(snap, me.id)) throw err('not_allowed', 403);
  return { c, snap };
}
function listReports(sid, me, { status, before } = {}) {
  const { c, snap } = reportAccess(sid, me);
  let where = 'community_id = ?';
  const params = [c.id];
  if (['open', 'resolved', 'dismissed'].includes(status)) { where += ' AND status = ?'; params.push(status); }
  if (before && /^\d{1,15}$/.test(String(before))) { where += ' AND id < ?'; params.push(Number(before)); }
  const rows = db.all(`SELECT * FROM reports WHERE ${where} ORDER BY id DESC LIMIT 50`, ...params);
  return { reports: rows.map(r => reportView(r, snap)), open: openCount(c), has_more: rows.length === 50 };
}
function setReportStatus(sid, me, id, body = {}) {
  const { c, snap } = reportAccess(sid, me);
  const r = /^\d{1,15}$/.test(String(id)) && db.get('SELECT * FROM reports WHERE id = ? AND community_id = ?', Number(id), c.id);
  if (!r) throw err('report_not_found', 404);
  const status = body.status;
  if (!['open', 'resolved', 'dismissed'].includes(status)) throw err('invalid_status');
  const note = body.note === undefined ? r.note : clean(body.note, 500);
  if (status === 'open') db.run("UPDATE reports SET status = 'open', resolved_by = NULL, resolved_at = NULL, note = ? WHERE id = ?", note, r.id);
  else db.run('UPDATE reports SET status = ?, resolved_by = ?, resolved_at = ?, note = ? WHERE id = ?', status, me.id, now(), note, r.id);
  if (status !== r.status) {
    const target = r.target_user_id ? auth.userById(r.target_user_id) : null;
    audit.record(c, me, status === 'resolved' ? 'report_resolve' : status === 'dismissed' ? 'report_dismiss' : 'report_reopen', { target: target ? { kind: 'user', id: target.principal, name: target.username } : { kind: 'report', id: r.id }, details: { report: String(r.id), kind: r.kind, ...(note ? { note } : {}) } });
  }
  const view = reportView(db.get('SELECT * FROM reports WHERE id = ?', r.id), snap);
  gateway.emitWhere(c.id, { type: 'chat_report', server: c.sid, report: view, open: openCount(c) }, uid => isModerator(snap, uid));
  return { report: view };
}

module.exports = { timeoutUntil, timeOut, timeOutBy, liftTimeout, listTimeouts, blockedWord, beforePost, createReport, listReports, setReportStatus, openCount, isModerator, _spam: spam };
