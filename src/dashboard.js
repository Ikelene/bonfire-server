'use strict';
// Server settings > Dashboard: members / bans / messages / disk at a glance, the server's health, where the storage goes and
// which channels hold the conversation. GET /api/v1/servers/:sid/dashboard (Manage server). Cached for 30 s: it adds up tables.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const V = require('./version');
const pkg = require('../package.json');

// database tables -> the storage groups the page shows
const GROUPS = {
  messages: ['messages', 'reactions', 'read_state', 'starboard', 'webhooks'],
  members: ['users', 'members', 'member_roles', 'sessions', 'bans', 'join_requests', 'timeouts', 'notify', 'jti_seen', 'instance_admins', 'role_purchases', 'role_payments', 'bots'],
  roles: ['roles', 'channel_perms', 'channels', 'communities', 'invites'],
  moderation: ['audit_log', 'reports'],
  previews: ['unfurls'],
};
const LABELS = { messages: 'Channel messages', uploads: 'Uploaded files', members: 'Member data', roles: 'Roles & channels', media: 'Emojis & sounds', previews: 'Link previews', moderation: 'Audit log & reports', backups: 'Backups', config: 'Config', other: 'Other files & data' };

const size = f => { try { return fs.statSync(f).size; } catch { return 0; } };
function dirSize(dir, budget = 20000) {
  let n = 0, seen = 0;
  const walk = d => {
    let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (++seen > budget) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile()) n += size(p);
    }
  };
  walk(dir);
  return n;
}
// bytes per table (dbstat when SQLite has it; otherwise nothing per table and the whole database counts as "other")
function tableBytes() {
  try {
    const rows = db.all('SELECT s.tbl_name AS t, SUM(d.pgsize) AS n FROM dbstat d JOIN sqlite_schema s ON s.name = d.name GROUP BY s.tbl_name');
    return new Map(rows.map(r => [r.t, Number(r.n) || 0]));
  } catch { return new Map(); }
}

let cache = new Map(); // community id -> { at, v }
function view(c) {
  const hit = cache.get(c.id);
  if (hit && Date.now() - hit.at < 30000) return hit.v;
  const n = (sql, ...p) => Number(db.get(sql, ...p)?.n || 0);
  const dir = config.dir();
  const dbTotal = ['bonfire.db', 'bonfire.db-wal', 'bonfire.db-shm'].reduce((t, f) => t + size(path.join(dir, f)), 0);
  const tables = tableBytes();
  const groups = { messages: 0, uploads: 0, members: 0, roles: 0, media: 0, previews: 0, moderation: 0, backups: 0, config: 0, other: 0 };
  let counted = 0;
  for (const [g, list] of Object.entries(GROUPS)) for (const t of list) { const b = tables.get(t) || 0; groups[g] += b; counted += b; }
  groups.other += Math.max(0, dbTotal - counted);
  groups.uploads = n('SELECT COALESCE(SUM(size), 0) AS n FROM uploads');
  for (const r of [...db.all('SELECT file FROM emojis WHERE community_id = ?', c.id), ...db.all('SELECT file FROM sounds WHERE community_id = ?', c.id)]) groups.media += size(path.join(dir, 'uploads', r.file));
  groups.previews += dirSize(path.join(dir, 'uploads', 'embeds'));
  groups.backups = n('SELECT COALESCE(SUM(size), 0) AS n FROM instance_backups');
  groups.config = size(path.join(dir, 'config.json'));
  const disk = Object.values(groups).reduce((a, b) => a + b, 0);

  const chans = db.all(`SELECT ch.cid, ch.name, ch.type, COUNT(m.id) AS messages, COALESCE(SUM(LENGTH(m.body) + COALESCE(LENGTH(m.attachments), 0) + COALESCE(LENGTH(m.embeds), 0)), 0) AS bytes
    FROM channels ch LEFT JOIN messages m ON m.channel_id = ch.id AND m.system = 0 WHERE ch.community_id = ? GROUP BY ch.id`, c.id);
  const talk = chans.filter(x => !['voice', 'link', 'roles'].includes(x.type));
  const withMsgs = talk.filter(x => x.messages > 0);
  const top = key => [...withMsgs].sort((a, b) => b[key] - a[key]).slice(0, 10).map(x => ({ cid: x.cid, name: x.name, messages: Number(x.messages), bytes: Number(x.bytes) }));
  const b = V.build(), mem = process.memoryUsage();
  const v = {
    members: n("SELECT COUNT(*) AS n FROM members m JOIN users u ON u.id = m.user_id WHERE m.community_id = ? AND u.kind <> 'bot'", c.id),
    bots: n("SELECT COUNT(*) AS n FROM members m JOIN users u ON u.id = m.user_id WHERE m.community_id = ? AND u.kind = 'bot'", c.id),
    banned: n('SELECT COUNT(*) AS n FROM bans WHERE community_id = ?', c.id),
    messages: withMsgs.reduce((t, x) => t + Number(x.messages), 0),
    open_reports: n("SELECT COUNT(*) AS n FROM reports WHERE community_id = ? AND status = 'open'", c.id),
    timeouts: n('SELECT COUNT(*) AS n FROM timeouts WHERE community_id = ? AND until > ?', c.id, Date.now()),
    disk,
    storage: Object.entries(groups).filter(([, bytes]) => bytes > 0).sort((a, b2) => b2[1] - a[1]).map(([key, bytes]) => ({ key, label: LABELS[key], bytes })),
    health: { runtime: `Node ${process.version.replace(/^v/, '')}`, memory: mem.rss, heap: mem.heapUsed, uptime_s: V.runtime().uptime_s, version: pkg.version, commit_short: b.commit_short },
    channels: { with_messages: withMsgs.length, empty: talk.length - withMsgs.length, by_messages: top('messages'), by_storage: top('bytes') },
  };
  cache.set(c.id, { at: Date.now(), v });
  return v;
}
const _reset = () => { cache = new Map(); };

module.exports = { view, _reset };
