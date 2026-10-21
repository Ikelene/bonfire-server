'use strict';
// Velora-hosted ("managed") instances (PROTOCOL §19): the host (bonfire-hostd) starts the container with BONFIRE_MANAGED=1,
// BONFIRE_PLAN and BONFIRE_LIMITS (JSON), and this module turns them into limits the rest of the server asks about.
// Everything reads the environment lazily, so a test can flip it between runs. Without BONFIRE_MANAGED nothing here limits anything.
const { err, normalizeOrigin } = require('./util');

// the plan numbers Velora ships (bonfire-plans.js); BONFIRE_LIMITS overrides field by field. null = unlimited.
const PLAN_DEFAULTS = {
  // files_per_member: uploads each person keeps; upload_expiry_days: the longest an upload is kept; storage_mb: all uploads together
  starter: { member_cap: 30, max_upload_mb: 10, emojis: 50, sounds: 10, bots: 2, bridges: false, custom_voice_keys: false, files_per_member: 500, upload_expiry_days: null, storage_mb: 2048 },
  plus: { member_cap: null, max_upload_mb: 250, emojis: null, sounds: null, bots: null, bridges: true, custom_voice_keys: true, files_per_member: null, upload_expiry_days: null, storage_mb: null },
};
const LOCKED = ['accounts_mode', 'public_url', 'velora_url', 'velora_registration'];

const active = () => process.env.BONFIRE_MANAGED === '1';
const plan = () => { const p = String(process.env.BONFIRE_PLAN || 'starter').toLowerCase(); return /^[a-z0-9_-]{1,24}$/.test(p) ? p : 'starter'; };
const num = (v, d, max) => (v === null ? null : (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.min(Math.trunc(Number(v)), max) : d);

let cache = { raw: null, plan: null, v: null };
function limits() {
  const raw = process.env.BONFIRE_LIMITS || '', p = plan();
  if (cache.raw === raw && cache.plan === p) return cache.v;
  const d = PLAN_DEFAULTS[p] || PLAN_DEFAULTS.starter;
  let o = {};
  try { const j = JSON.parse(raw || '{}'); if (j && typeof j === 'object' && !Array.isArray(j)) o = j; } catch { /* bad JSON: plan defaults */ }
  const v = {
    member_cap: o.member_cap === undefined ? d.member_cap : num(o.member_cap, d.member_cap, 1e7),
    max_upload_mb: o.max_upload_mb === undefined ? d.max_upload_mb : num(o.max_upload_mb, d.max_upload_mb, 500),
    emojis: o.emojis === undefined ? d.emojis : num(o.emojis, d.emojis, 1e5),
    sounds: o.sounds === undefined ? d.sounds : num(o.sounds, d.sounds, 1e5),
    bots: o.bots === undefined ? d.bots : num(o.bots, d.bots, 1e5),
    files_per_member: o.files_per_member === undefined ? d.files_per_member : num(o.files_per_member, d.files_per_member, 1e6),
    upload_expiry_days: o.upload_expiry_days === undefined ? d.upload_expiry_days : num(o.upload_expiry_days, d.upload_expiry_days, 3650),
    storage_mb: o.storage_mb === undefined ? d.storage_mb : num(o.storage_mb, d.storage_mb, 1e8),
    bridges: typeof o.bridges === 'boolean' ? o.bridges : d.bridges,
    custom_voice_keys: typeof o.custom_voice_keys === 'boolean' ? o.custom_voice_keys : d.custom_voice_keys,
  };
  cache = { raw, plan: p, v };
  return v;
}

// the `managed` object of /.well-known/bonfire and GET /api/v1/instance/settings; null on a normal instance
const view = () => (active() ? { plan: plan(), limits: { ...limits() }, host: 'velora' } : null);

// numeric limit for emojis / sounds / bots / member_cap / max_upload_mb / files_per_member / upload_expiry_days / storage_mb: a number, or null (none)
const limit = what => (active() ? limits()[what] ?? null : null);
const allows = what => !active() || limits()[what] !== false;

// read-only mode (BONFIRE_READ_ONLY=1, set by the host when a hosted server's paid time ran out): every write is refused, reading and the export still work
const readOnly = () => process.env.BONFIRE_READ_ONLY === '1';
function assertWritable() { if (readOnly()) throw err('read_only', 403); }

const planLimit = (what, lim, used = null) => err('plan_limit', 403, { what, limit: lim, used, ...(active() ? { plan: plan() } : {}) });
const planFeature = what => err('plan_feature', 403, { what, limit: 0, ...(active() ? { plan: plan() } : {}), message: 'This plan does not include ' + what.replace(/_/g, ' ') + '.' });
// throws plan_limit when `count` already reached the limit (creating one more would exceed it)
function assertRoom(what, count, plural = what) {
  const lim = limit(what);
  if (lim === 0) throw planFeature(plural);
  if (lim !== null && count >= lim) throw planLimit(plural, lim, count);
}
function assertAllows(what) { if (!allows(what)) throw planFeature(what); }

// joining past the member cap: the owner and instance admins are never blocked; bots do not count (the caller passes the human count)
function assertCanJoin(humanCount, isAdminOrOwner) {
  const cap = limit('member_cap');
  if (cap === 0 && !isAdminOrOwner) throw planFeature('member_cap');
  if (cap !== null && !isAdminOrOwner && humanCount >= cap) throw err('member_cap_reached', 403, { cap, what: 'member_cap', limit: cap, used: humanCount, plan: plan() });
}

// PATCH /api/v1/instance/settings: locked settings and custom voice keys. A locked setting sent with its current value is accepted
// (the admin UI sends whole forms back); a different value is refused.
function guardSettings(body, current) {
  if (!active() || !body || typeof body !== 'object') return;
  const same = {
    accounts_mode: v => v === 'velora',
    velora_registration: v => v === 'auto',
    public_url: v => typeof v === 'string' && normalizeOrigin(v) === current.public_url,
    velora_url: v => typeof v === 'string' && normalizeOrigin(v) === current.velora_url,
  };
  for (const k of LOCKED) if (body[k] !== undefined && !same[k](body[k])) throw err('managed_setting', 403, { setting: k });
  if (body.voice && typeof body.voice === 'object' && !limits().custom_voice_keys && Object.values(body.voice).some(v => typeof v === 'string' && v.trim())) throw planFeature('custom_voice_keys');
}

// Usage follows enforcement: current bot memberships and humans, rather than retained account history.
function botCount(communityId = null) {
  const db = require('./db');
  return db.get('SELECT COUNT(*) AS n FROM bots b WHERE EXISTS (SELECT 1 FROM members m WHERE m.user_id = b.user_id' + (communityId === null ? '' : ' AND m.community_id = ?') + ')', ...(communityId === null ? [] : [communityId])).n;
}
function usage() {
  if (!active()) return null;
  const db = require('./db'), c = db.get('SELECT id FROM communities ORDER BY id LIMIT 1');
  const count = table => c ? db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE community_id = ?`, c.id).n : 0;
  const used = { bots: botCount(c?.id ?? null), emojis: count('emojis'), sounds: count('sounds'), member_cap: c ? db.get("SELECT COUNT(*) AS n FROM members m JOIN users u ON u.id = m.user_id WHERE m.community_id = ? AND u.kind <> 'bot'", c.id).n : 0, max_upload_mb: null,
    files_per_member: null, upload_expiry_days: null, storage_mb: Math.ceil(db.get('SELECT COALESCE(SUM(size), 0) AS n FROM uploads').n / (1024 * 1024)) };
  const numeric = Object.fromEntries(Object.entries(used).map(([key, n]) => [key, { limit: limit(key), used: n }]));
  return { name: plan(), limits: numeric, features: { bridges: allows('bridges'), custom_voice_keys: allows('custom_voice_keys'), ...Object.fromEntries(['bots', 'emojis', 'sounds'].map(k => [k, limit(k) !== 0])), uploads: limit('max_upload_mb') !== 0, backups: true, game_servers: true, bonfire_link: true, webhooks: true } };
}

module.exports = { readOnly, assertWritable, active, plan, limits, view, limit, allows, assertRoom, assertAllows, assertCanJoin, guardSettings, planLimit, planFeature, botCount, usage, PLAN_DEFAULTS, LOCKED };
