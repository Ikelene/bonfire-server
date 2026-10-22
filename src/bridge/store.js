'use strict';
// Tables for the external integrations (Discord / Fluxer bridge, CloudLink, Ember Link). They are made here with
// CREATE TABLE IF NOT EXISTS at boot instead of as db.js migrations, so this wave stays out of the core schema.
const db = require('../db');

let made = null; // the connection the tables were checked on (tests / restarts reopen the database)
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS bridge_settings (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS bridge_guilds (
    id INTEGER PRIMARY KEY AUTOINCREMENT, community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    platform TEXT NOT NULL, guild_id TEXT NOT NULL, guild_name TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER, created_at INTEGER NOT NULL, UNIQUE (community_id, platform)
  );
  CREATE TABLE IF NOT EXISTS bridge_channels (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE, bridge_id INTEGER NOT NULL REFERENCES bridge_guilds(id) ON DELETE CASCADE,
    ext_channel_id TEXT NOT NULL, ext_name TEXT NOT NULL DEFAULT '', hook_id TEXT, hook_token TEXT, PRIMARY KEY (channel_id, bridge_id)
  );
  CREATE INDEX IF NOT EXISTS bridge_channels_ext ON bridge_channels(ext_channel_id);
  CREATE INDEX IF NOT EXISTS bridge_channels_hook ON bridge_channels(hook_id);
  CREATE TABLE IF NOT EXISTS bridge_msgs (
    message_id INTEGER NOT NULL, platform TEXT NOT NULL, ext_message_id TEXT NOT NULL, ext_channel_id TEXT NOT NULL,
    outbound INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (message_id, platform)
  );
  CREATE INDEX IF NOT EXISTS bridge_msgs_ext ON bridge_msgs(ext_message_id, platform);
  CREATE INDEX IF NOT EXISTS bridge_msgs_at ON bridge_msgs(created_at);
  CREATE TABLE IF NOT EXISTS bridge_from (message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, src TEXT NOT NULL);
`;
function ensure() {
  const raw = db.raw();
  if (!raw || made === raw) return;
  raw.exec(SCHEMA);
  made = raw;
}

// small key/value store for instance-level bridge settings (bot tokens). Never sent to clients as-is.
const setting = k => { ensure(); return db.get('SELECT v FROM bridge_settings WHERE k = ?', k)?.v ?? null; };
function setSetting(k, v) {
  ensure();
  if (v == null) db.run('DELETE FROM bridge_settings WHERE k = ?', k);
  else db.run('INSERT INTO bridge_settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v));
}

// author.bridge_from: the place a bridged message was relayed from before it reached us (a Velocity backend such as
// "survival", or "Discord" for a CloudLink message that came through another bridge). messages.js reads / writes it.
function fromOf(messageId) {
  ensure();
  return db.get('SELECT src FROM bridge_from WHERE message_id = ?', Number(messageId))?.src || null;
}
function setFrom(messageId, src) {
  ensure();
  if (src) db.run('INSERT OR REPLACE INTO bridge_from (message_id, src) VALUES (?, ?)', Number(messageId), String(src).slice(0, 40));
}

module.exports = { ensure, setting, setSetting, fromOf, setFrom };
