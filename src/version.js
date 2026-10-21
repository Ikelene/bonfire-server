'use strict';
// Build identity + live stats + "am I outdated?" (PROTOCOL §3 `build`, §5c `GET /api/v1/instance/info`).
// The image is built with BONFIRE_BUILD_* env vars (Dockerfile ARG -> ENV, set by hostd/rebuild-image.sh); a build-info.json beside
// package.json is the fallback for a plain checkout. Without either, commit is null and no update check is made.
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const config = require('./config');
const db = require('./db');

const startedAt = Date.now();
let fileInfo = {};
try { fileInfo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'build-info.json'), 'utf8')); } catch { /* not built by the release script */ }
const pick = (envKey, key) => { const v = process.env[envKey] || fileInfo[key]; return v ? String(v) : null; };

function build() {
  const commit = pick('BONFIRE_BUILD_COMMIT', 'commit');
  return {
    version: pkg.version,
    commit,
    commit_short: commit ? commit.slice(0, 7) : null,
    commit_date: pick('BONFIRE_BUILD_COMMIT_DATE', 'commit_date'), // ISO 8601, date of the commit
    built_at: pick('BONFIRE_BUILD_AT', 'built_at'),                // ISO 8601, when the image was built
    dirty: (pick('BONFIRE_BUILD_DIRTY', 'dirty') || '0') === '1' || fileInfo.dirty === true,
    build_id: pick('BONFIRE_BUILD_ID', 'build_id') || commit, // commit, + "+<treehash>" when built from uncommitted changes
  };
}

// ---- live stats (cached 30 s: COUNT(*) over a big messages table is not free) ----
let statsCache = { at: 0, v: null };
function dbBytes() {
  let n = 0;
  for (const f of ['bonfire.db', 'bonfire.db-wal', 'bonfire.db-shm']) { try { n += fs.statSync(path.join(config.dir(), f)).size; } catch { /* absent */ } }
  return n;
}
function stats() {
  if (statsCache.v && Date.now() - statsCache.at < 30000) return { ...statsCache.v, bots: require('./managed').botCount() };
  const n = (sql) => db.get(sql)?.n || 0;
  const v = {
    members: n('SELECT COUNT(*) n FROM members'),
    channels: n('SELECT COUNT(*) n FROM channels'),
    messages: n('SELECT COUNT(*) n FROM messages'),
    upload_count: n('SELECT COUNT(*) n FROM uploads'),
    upload_bytes: n('SELECT COALESCE(SUM(size),0) n FROM uploads'),
    db_bytes: dbBytes(),
    bots: require('./managed').botCount(),
    emojis: n('SELECT COUNT(*) n FROM emojis'),
    sounds: n('SELECT COUNT(*) n FROM sounds'),
  };
  statsCache = { at: Date.now(), v };
  return v;
}
const runtime = () => ({ node: process.version, uptime_s: Math.round((Date.now() - startedAt) / 1000), started_at: new Date(startedAt).toISOString(), platform: process.platform });

// ---- update check against Velora's published "latest" (cache ~1 h, silent on failure) ----
const LATEST_URL = () => process.env.BONFIRE_LATEST_URL || 'https://velora.ikelene.net/bonfire/server-latest.json';
const OK_TTL = 3600 * 1000, FAIL_TTL = 10 * 60 * 1000;
let latest = { at: 0, ttl: 0, v: null, pending: null };
async function fetchLatest() {
  if (process.env.BONFIRE_UPDATE_CHECK === '0') return null;
  if (latest.pending) return latest.pending;
  if (latest.at && Date.now() - latest.at < latest.ttl) return latest.v;
  latest.pending = (async () => {
    try {
      const r = await fetch(LATEST_URL(), { signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('status');
      const j = await r.json();
      if (!j || typeof j !== 'object' || !j.commit) throw new Error('shape');
      const s = k => (typeof j[k] === 'string' ? j[k].slice(0, 80) : null);
      latest.v = { version: s('version'), commit: s('commit'), commit_short: s('commit_short') || (s('commit') || '').slice(0, 7) || null, commit_date: s('commit_date'), built_at: s('built_at'), build_id: s('build_id') || s('commit'), dirty: !!j.dirty, message: s('message') };
      latest.ttl = OK_TTL;
    } catch { latest.ttl = FAIL_TTL; /* keep the previous value, if any */ }
    latest.at = Date.now();
    return latest.v;
  })();
  try { return await latest.pending; } finally { latest.pending = null; }
}
// {outdated, latest, checked_at} or null when we cannot tell (unbuilt server, check disabled, Velora unreachable)
async function update() {
  const me = build();
  const l = await fetchLatest();
  if (!l || !me.build_id) return null;
  let outdated = l.build_id !== me.build_id;
  if (outdated && l.built_at && me.built_at) outdated = Date.parse(l.built_at) > Date.parse(me.built_at); // never nag a server that is ahead
  return { outdated, latest: l, checked_at: new Date(latest.at).toISOString() };
}

module.exports = { build, stats, runtime, update, startedAt };
