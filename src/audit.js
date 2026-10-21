'use strict';
// The audit log: a record of every moderation and settings action in a community (Server settings > Audit log).
// record() is called right after the action succeeded; the server's settings say whether to keep a log and for how long
// (one number, and optionally a different number per category). GET /api/v1/servers/:sid/audit (Manage server, Kick or Ban).
const db = require('./db');
const { now } = require('./util');

// action -> category
const ACTIONS = {
  member_kick: 'user_moderation', member_ban: 'user_moderation', member_unban: 'user_moderation', member_timeout: 'user_moderation',
  timeout_remove: 'user_moderation', join_accept: 'user_moderation', join_deny: 'user_moderation',
  role_create: 'role_management', role_update: 'role_management', role_delete: 'role_management', role_order: 'role_management',
  member_role_add: 'role_management', member_role_remove: 'role_management',
  channel_create: 'channel_management', channel_update: 'channel_management', channel_delete: 'channel_management',
  channel_perms: 'channel_management', channel_layout: 'channel_management',
  message_delete: 'message_moderation', message_pin: 'message_moderation', message_unpin: 'message_moderation', automod_block: 'message_moderation',
  spam_pause: 'message_moderation', report_resolve: 'message_moderation', report_dismiss: 'message_moderation', report_reopen: 'message_moderation',
  server_update: 'server_management', settings_update: 'server_management', invite_create: 'server_management', invite_delete: 'server_management',
  emoji_create: 'server_management', emoji_rename: 'server_management', emoji_delete: 'server_management',
};

const json = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// c: community row; actor: user row / id / null (AutoMod); target: { kind, id, name }; details: small plain object
function record(c, actor, action, { target = null, details = null } = {}) {
  try {
    if (!c || !ACTIONS[action]) return;
    if (!require('./settings').get(c).audit.enabled) return;
    const actorId = actor == null ? null : typeof actor === 'object' ? actor.id : Number(actor);
    const d = details && Object.keys(details).length ? JSON.stringify(details).slice(0, 4000) : null;
    db.run('INSERT INTO audit_log (community_id, actor_id, action, category, target_kind, target_id, target_name, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      c.id, actorId, action, ACTIONS[action], target?.kind || null, target?.id != null ? String(target.id).slice(0, 80) : null, target?.name != null ? String(target.name).slice(0, 120) : null, d, now());
  } catch (e) { console.error('[audit] could not record', action, e.message); }
}

// drop entries past their category's retention (every community)
function prune() {
  try {
    const S = require('./settings');
    for (const c of db.all('SELECT id, settings FROM communities')) {
      const a = S.get(c).audit;
      const days = cat => a.retention[cat] ?? a.retention_days;
      for (const cat of S.AUDIT_CATEGORIES) db.run('DELETE FROM audit_log WHERE community_id = ? AND category = ? AND created_at < ?', c.id, cat, now() - days(cat) * 86400000);
    }
  } catch (e) { console.error('[audit] prune', e.message); }
}
let timer = null;
function start() { prune(); clearInterval(timer); timer = setInterval(prune, 3600 * 1000); timer.unref?.(); }
function stop() { clearInterval(timer); timer = null; }

// newest first, 50 a page: { entries, has_more }
function list(c, { category, action, before, limit } = {}) {
  const auth = require('./auth');
  let where = 'community_id = ?';
  const params = [c.id];
  if (category && category !== 'all') { where += ' AND category = ?'; params.push(String(category)); }
  if (action && action !== 'all') { where += ' AND action = ?'; params.push(String(action)); }
  if (before && /^\d{1,15}$/.test(String(before))) { where += ' AND id < ?'; params.push(Number(before)); }
  const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const rows = db.all(`SELECT * FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT ${n}`, ...params);
  const people = new Map();
  const who = id => { if (id == null) return null; if (!people.has(id)) people.set(id, auth.userView(auth.userById(id))); return people.get(id); };
  return {
    entries: rows.map(r => ({ id: String(r.id), action: r.action, category: r.category, actor: who(r.actor_id), automod: r.actor_id == null, target: r.target_kind ? { kind: r.target_kind, id: r.target_id, name: r.target_name } : null, details: json(r.details), created_at: r.created_at })),
    has_more: rows.length === n,
    actions: Object.keys(ACTIONS), action_categories: ACTIONS, categories: require('./settings').AUDIT_CATEGORIES,
  };
}

module.exports = { ACTIONS, record, prune, start, stop, list };
