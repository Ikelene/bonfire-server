'use strict';
// Velora-hosted ("managed") instances (PROTOCOL §19): the host (bonfire-hostd) starts the container with BONFIRE_MANAGED=1,
// BONFIRE_PLAN and BONFIRE_LIMITS (JSON), and this module turns them into limits the rest of the server asks about.
// Everything reads the environment lazily, so a test can flip it between runs. Without BONFIRE_MANAGED nothing here limits anything.
const { err, normalizeOrigin } = require('./util');

// the plan numbers Velora ships (bonfire-plans.js); BONFIRE_LIMITS overrides field by field. null = unlimited.
const PLAN_DEFAULTS = {
  starter: { member_cap: 30, max_upload_mb: 10, emojis: 50, sounds: 10, bots: 2, bridges: false, custom_voice_keys: false },
  plus: { member_cap: null, max_upload_mb: 250, emojis: null, sounds: null, bots: null, bridges: true, custom_voice_keys: true },
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
    bridges: typeof o.bridges === 'boolean' ? o.bridges : d.bridges,
    custom_voice_keys: typeof o.custom_voice_keys === 'boolean' ? o.custom_voice_keys : d.custom_voice_keys,
  };
  cache = { raw, plan: p, v };
  return v;
}

// the `managed` object of /.well-known/bonfire and GET /api/v1/instance/settings; null on a normal instance
const view = () => (active() ? { plan: plan(), limits: { ...limits() }, host: 'velora' } : null);

// numeric limit for emojis / sounds / bots / member_cap / max_upload_mb: a number, or null (none)
const limit = what => (active() ? limits()[what] ?? null : null);
const allows = what => !active() || limits()[what] !== false;

// read-only mode (BONFIRE_READ_ONLY=1, set by the host when a hosted server's paid time ran out): every write is refused, reading and the export still work
const readOnly = () => process.env.BONFIRE_READ_ONLY === '1';
function assertWritable() { if (readOnly()) throw err('read_only', 403); }

const planLimit = (what, lim) => err('plan_limit', 403, { what, limit: lim });
// throws plan_limit when `count` already reached the limit (creating one more would exceed it)
function assertRoom(what, count, plural = what) {
  const lim = limit(what);
  if (lim !== null && count >= lim) throw planLimit(plural, lim);
}
function assertAllows(what) { if (!allows(what)) throw planLimit(what, false); }

// joining past the member cap: the owner and instance admins are never blocked; bots do not count (the caller passes the human count)
function assertCanJoin(humanCount, isAdminOrOwner) {
  const cap = limit('member_cap');
  if (cap !== null && !isAdminOrOwner && humanCount >= cap) throw err('member_cap_reached', 403, { cap });
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
  if (body.voice && typeof body.voice === 'object' && !limits().custom_voice_keys && Object.values(body.voice).some(v => typeof v === 'string' && v.trim())) throw planLimit('custom_voice_keys', false);
}

module.exports = { readOnly, assertWritable, active, plan, limits, view, limit, allows, assertRoom, assertAllows, assertCanJoin, guardSettings, planLimit, PLAN_DEFAULTS, LOCKED };
