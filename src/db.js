'use strict';
const path = require('path');
// Node's built-in SQLite: no native addon to download or compile, on any platform. Still flagged experimental in
// Node 22/24, so drop that one warning instead of printing it on every start.
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w?.message ?? w).includes('SQLite') ? undefined : emitWarning.call(process, w, ...rest));
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

let db = null;
const cache = new Map();
const stmt = sql => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };

const MIGRATIONS = [
  // v1: initial schema
  `
  CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, principal TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
    username TEXT NOT NULL, display_name TEXT NOT NULL, pfp TEXT, velora_id TEXT,
    username_lc TEXT, password_hash TEXT, settings TEXT, banned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, last_login INTEGER
  );
  CREATE UNIQUE INDEX users_local_name ON users(username_lc) WHERE kind = 'local';
  CREATE TABLE sessions (
    hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scopes TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, last_used INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE jti_seen (jti TEXT PRIMARY KEY, exp INTEGER NOT NULL);
  CREATE TABLE instance_admins (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE);
  CREATE TABLE auto_joined (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE);

  CREATE TABLE communities (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    icon_url TEXT, banner_url TEXT, owner_id INTEGER NOT NULL REFERENCES users(id), invite_code TEXT NOT NULL UNIQUE,
    categories TEXT NOT NULL DEFAULT '[]', join_policy TEXT NOT NULL DEFAULT 'request',
    allow_uploads INTEGER NOT NULL DEFAULT 1, upload_max_mb INTEGER NOT NULL DEFAULT 25,
    listed INTEGER NOT NULL DEFAULT 0, allow_accent INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
  );
  CREATE TABLE members (
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at INTEGER NOT NULL, PRIMARY KEY (community_id, user_id)
  );
  CREATE INDEX members_user ON members(user_id);
  CREATE TABLE bans (
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_by INTEGER, created_at INTEGER NOT NULL, PRIMARY KEY (community_id, user_id)
  );
  CREATE TABLE channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT, cid TEXT NOT NULL UNIQUE, community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    name TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0,
    locked INTEGER NOT NULL DEFAULT 0, icon TEXT, type TEXT NOT NULL DEFAULT 'text', config TEXT NOT NULL DEFAULT '{}',
    last_message_id INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE INDEX channels_community ON channels(community_id);
  CREATE TABLE roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, rid TEXT NOT NULL UNIQUE, community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    name TEXT NOT NULL, color TEXT, icon_url TEXT, position INTEGER NOT NULL DEFAULT 0, permissions INTEGER NOT NULL DEFAULT 0,
    hoist INTEGER NOT NULL DEFAULT 0, mentionable INTEGER NOT NULL DEFAULT 0, is_default INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX roles_community ON roles(community_id);
  CREATE TABLE member_roles (
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE, PRIMARY KEY (community_id, user_id, role_id)
  );
  CREATE TABLE channel_perms (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE, role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    allow INTEGER NOT NULL DEFAULT 0, deny INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (channel_id, role_id)
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, body TEXT NOT NULL, reply_to INTEGER, attachments TEXT,
    system INTEGER NOT NULL DEFAULT 0, sys_kind TEXT, subject_user_id INTEGER, subject_parts TEXT,
    mention_everyone INTEGER NOT NULL DEFAULT 0, mention_roles TEXT, author_name TEXT, author_avatar TEXT, embeds TEXT, bridge TEXT,
    pinned_at INTEGER, pinned_by INTEGER, created_at INTEGER NOT NULL, edited_at INTEGER,
    sig_kid TEXT, sig_sig TEXT, sig_ts INTEGER, sig_nonce TEXT, verified INTEGER
  );
  CREATE INDEX messages_channel ON messages(channel_id, id);
  CREATE TABLE reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (message_id, user_id, emoji)
  );
  CREATE TABLE read_state (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, channel_id)
  );
  CREATE TABLE emojis (
    id INTEGER PRIMARY KEY AUTOINCREMENT, eid TEXT NOT NULL UNIQUE, community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    name TEXT NOT NULL, animated INTEGER NOT NULL DEFAULT 0, file TEXT NOT NULL, created_by INTEGER, created_at INTEGER NOT NULL
  );
  CREATE TABLE invites (
    code TEXT PRIMARY KEY, community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE, created_by INTEGER,
    created_at INTEGER NOT NULL, expires_at INTEGER, max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE join_requests (
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, PRIMARY KEY (community_id, user_id)
  );
  CREATE TABLE notify (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, target TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'default',
    muted_until INTEGER, push INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (user_id, target)
  );
  CREATE TABLE uploads (
    path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, type TEXT NOT NULL,
    width INTEGER, height INTEGER, user_id INTEGER, created_at INTEGER NOT NULL
  );
  `,
  // v2: auto_join is gone (one community per instance)
  `DROP TABLE IF EXISTS auto_joined;`,
  // v3: webhooks, starboard, soundboard, link-preview cache, bot accounts
  `
  ALTER TABLE messages ADD COLUMN webhook_id INTEGER;
  CREATE TABLE webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, wid TEXT NOT NULL UNIQUE, token TEXT NOT NULL, community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE, name TEXT NOT NULL, avatar TEXT, created_by INTEGER, created_at INTEGER NOT NULL
  );
  CREATE INDEX webhooks_channel ON webhooks(channel_id);
  CREATE TABLE starboard (
    board_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    starred_at INTEGER NOT NULL, PRIMARY KEY (board_id, message_id)
  );
  CREATE INDEX starboard_at ON starboard(board_id, starred_at);
  CREATE TABLE sounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT NOT NULL UNIQUE, community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    name TEXT NOT NULL, emoji TEXT, volume INTEGER NOT NULL DEFAULT 100, duration_ms INTEGER NOT NULL DEFAULT 0, file TEXT NOT NULL, created_by INTEGER, created_at INTEGER NOT NULL
  );
  CREATE INDEX sounds_community ON sounds(community_id);
  CREATE TABLE unfurls (url_hash TEXT PRIMARY KEY, url TEXT NOT NULL, data TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE bots (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, owner_id INTEGER, token_hash TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '', public INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
  );
  `,
  // v4: Velora relays (PROTOCOL §12): paid roles-shop purchases (Velora's chat_role_purchases) and their pay requests
  `
  CREATE TABLE role_purchases (
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE, price INTEGER NOT NULL, rcp TEXT UNIQUE, ref TEXT, created_at INTEGER NOT NULL,
    PRIMARY KEY (community_id, user_id, role_id)
  );
  CREATE TABLE role_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE, amount INTEGER NOT NULL, ref TEXT NOT NULL UNIQUE,
    pay_id TEXT, approve_url TEXT, status TEXT NOT NULL DEFAULT 'creating', error TEXT, expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX role_payments_open ON role_payments(status, expires_at);
  CREATE INDEX role_payments_user ON role_payments(user_id, role_id, status);
  `,
  // v5: per-role upload overrides and portable instance backups
  `ALTER TABLE roles ADD COLUMN upload_max_mb INTEGER;
  CREATE TABLE instance_backups (
    id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, size INTEGER NOT NULL, by_principal TEXT NOT NULL, note TEXT NOT NULL DEFAULT ''
  );`,
  // v6: bot gallery (PROTOCOL §14.1): bots added from Velora's gallery keep their gallery id, a verified flag and an active flag
  `ALTER TABLE bots ADD COLUMN gallery_id TEXT;
  ALTER TABLE bots ADD COLUMN gallery_test INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE bots ADD COLUMN gallery_verified INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE bots ADD COLUMN gallery_active INTEGER NOT NULL DEFAULT 1;
  CREATE UNIQUE INDEX bots_gallery ON bots(gallery_id) WHERE gallery_id IS NOT NULL;`,
  // v7: server settings (src/settings.js), AutoMod timeouts, reports, the audit log, upload expiry, a Velora member's plan
  `ALTER TABLE communities ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE uploads ADD COLUMN expires_at INTEGER;
  CREATE INDEX uploads_expiry ON uploads(expires_at) WHERE expires_at IS NOT NULL;
  CREATE INDEX uploads_user ON uploads(user_id);
  ALTER TABLE users ADD COLUMN tier TEXT;
  CREATE TABLE timeouts (
    community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    until INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', PRIMARY KEY (community_id, user_id)
  );
  CREATE TABLE reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL, target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    message_id INTEGER, channel_id INTEGER, snapshot TEXT, reason TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
    resolved_by INTEGER, resolved_at INTEGER, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
  );
  CREATE INDEX reports_status ON reports(community_id, status, id);
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    actor_id INTEGER, action TEXT NOT NULL, category TEXT NOT NULL, target_kind TEXT, target_id TEXT, target_name TEXT, details TEXT, created_at INTEGER NOT NULL
  );
  CREATE INDEX audit_log_list ON audit_log(community_id, category, id);
  CREATE INDEX audit_log_age ON audit_log(created_at);`,
];

function open() {
  close();
  db = new DatabaseSync(path.join(config.dir(), 'bonfire.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
  const have = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = have; v < MIGRATIONS.length; v++) tx(() => { db.exec(MIGRATIONS[v]); db.exec(`PRAGMA user_version = ${v + 1}`); });
  return db;
}
function close() { if (db) { try { db.close(); } catch { /* closed */ } } db = null; cache.clear(); depth = 0; }

const get = (sql, ...p) => stmt(sql).get(...p);
const all = (sql, ...p) => stmt(sql).all(...p);
const run = (sql, ...p) => stmt(sql).run(...p);
// nested calls become savepoints, so a helper that opens its own transaction can run inside another
let depth = 0;
function tx(fn) {
  const sp = `sp${depth}`;
  db.exec(depth ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE');
  depth++;
  try {
    const out = fn();
    depth--;
    db.exec(depth ? `RELEASE ${sp}` : 'COMMIT');
    return out;
  } catch (e) {
    depth--;
    db.exec(depth ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK');
    throw e;
  }
}
const inList = ids => ids.map(() => '?').join(',');
const metaGet = k => get('SELECT v FROM meta WHERE k = ?', k)?.v ?? null;
const metaSet = (k, v) => run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
const metaDel = k => run('DELETE FROM meta WHERE k = ?', k);

module.exports = { open, close, get, all, run, tx, inList, metaGet, metaSet, metaDel, raw: () => db };
