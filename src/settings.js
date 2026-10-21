'use strict';
// Server settings: one JSON object per community (communities.settings) for joining, message rules, AutoMod, the audit log and
// uploads. GET / PATCH /api/v1/servers/:sid/settings (Manage server). Two keys reach outside the chat, so only instance admins
// change them: the link-preview proxy and AutoMod's word-list file on the server. On a Velora-hosted server the plan caps a few
// numbers (members, files per member, how long files are kept, total storage: managed.js); a saved number above the cap counts
// as the cap.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const managed = require('./managed');
const { err } = require('./util');

const DEFAULTS = {
  join: { allowlist: [], max_members: null, default_roles: [] }, // (+ password_hash, never shown)
  messages: { max_length: 4000, search_results: 25, max_reactions: 20, link_previews: true, preview_proxy: '' },
  automod: {
    words_enabled: false, words: [], word_file: '', whole_word: true, match_case: false, timeout_seconds: 60, exempt_roles: [],
    spam_enabled: false, spam_per_minute: null, spam_burst: null, spam_pause_seconds: null, // null = SPAM_DEFAULTS
  },
  audit: { enabled: true, retention_days: 90, retention: {} }, // retention: { category: days } overrides
  uploads: {
    per_minute: 30, files_per_member: null, types: ['any'], expire_days: null, never_expire_plans: [], never_expire_roles: [], storage_mb: null,
    compress: false, max_width: 1920, max_height: 1920, max_pixels: 50000000, jpeg_quality: 85,
  },
};
const SPAM_DEFAULTS = { per_minute: 30, burst: 8, pause_seconds: 0 };
const AUDIT_CATEGORIES = ['user_moderation', 'role_management', 'channel_management', 'message_moderation', 'server_management'];
const FILE_TYPES = ['any', 'images', 'videos', 'audio', 'pdf', 'text', 'archives'];
const MSG_MAX = 4000; // messages.js MSG_MAX: the most any server allows
const SECTIONS = Object.keys(DEFAULTS);

function raw(c) {
  let s = {};
  try { s = JSON.parse(c?.settings || '{}') || {}; } catch { s = {}; }
  const out = {};
  for (const k of SECTIONS) out[k] = { ...DEFAULTS[k], ...(s[k] && typeof s[k] === 'object' ? s[k] : {}) };
  return out;
}
// a plan number caps a saved one: null (unlimited) on the plan = the saved value, null saved = the plan's
const capped = (saved, plan) => (plan == null ? saved : saved == null ? plan : Math.min(saved, plan));
const planCaps = () => ({
  member_cap: managed.limit('member_cap'), files_per_member: managed.limit('files_per_member'), upload_expiry_days: managed.limit('upload_expiry_days') || null, // (0 days = keep forever)
  storage_mb: managed.limit('storage_mb'), max_upload_mb: managed.limit('max_upload_mb'),
});

// the settings in force (plan caps applied)
function get(c) {
  const s = raw(c), p = planCaps();
  s.join.max_members = capped(s.join.max_members, p.member_cap);
  s.uploads.files_per_member = capped(s.uploads.files_per_member, p.files_per_member);
  s.uploads.expire_days = capped(s.uploads.expire_days, p.upload_expiry_days);
  s.uploads.storage_mb = capped(s.uploads.storage_mb, p.storage_mb);
  s.messages.max_length = Math.min(Math.max(s.messages.max_length || MSG_MAX, 1), MSG_MAX);
  const a = s.automod;
  s.spam = { per_minute: a.spam_per_minute ?? SPAM_DEFAULTS.per_minute, burst: a.spam_burst ?? SPAM_DEFAULTS.burst, pause_seconds: a.spam_pause_seconds ?? SPAM_DEFAULTS.pause_seconds };
  return s;
}

// what the settings pages read (saved values, the plan's caps, nothing secret)
function view(c, me) {
  const s = raw(c);
  const { password_hash, ...join } = s.join;
  return {
    join_policy: c.join_policy, has_password: !!password_hash, ...s, join,
    spam_defaults: SPAM_DEFAULTS, plan: managed.active() ? planCaps() : null,
    image_compression_available: require('./images').available(),
    instance_admin: !!me && require('./auth').isAdmin(me), audit_categories: AUDIT_CATEGORIES, file_types: FILE_TYPES,
  };
}

// ---------- validation ----------
const bad = code => err(code, 400);
function int(v, min, max, code, nullable = false) {
  if (v === null && nullable) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(code);
  return n;
}
const bool = (v, code) => { if (typeof v !== 'boolean') throw bad(code); return v; };
function strList(v, { max, len, code, re, lower = true }) {
  if (!Array.isArray(v) || v.length > max) throw bad(code);
  const out = [];
  for (const x of v) {
    if (typeof x !== 'string') throw bad(code);
    let t = x.trim().replace(/^@/, '');
    if (lower) t = t.toLowerCase();
    if (!t || t.length > len || (re && !re.test(t))) throw bad(code);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
function httpUrl(v, code) {
  if (v === '' || v === null) return '';
  if (typeof v !== 'string' || v.length > 500) throw bad(code);
  let u; try { u = new URL(v.trim()); } catch { throw bad(code); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw bad(code);
  return v.trim();
}
// a file under the data folder (never anywhere else on the machine)
function dataFile(v, code) {
  if (v === '' || v === null) return '';
  if (typeof v !== 'string' || v.length > 300 || v.includes('\0')) throw bad(code);
  const abs = path.resolve(config.dir(), v.trim());
  if (!abs.startsWith(path.resolve(config.dir()) + path.sep)) throw bad(code);
  return path.relative(config.dir(), abs);
}
const wordFilePath = rel => (rel ? path.resolve(config.dir(), rel) : null);

// rids that exist (and, for roles handed out, that the person setting them could hand out themselves)
function roleList(v, snap, me, { grantable }) {
  if (!Array.isArray(v) || v.length > 25) throw bad('invalid_roles');
  const { P } = require('./perms');
  const out = [];
  for (const rid of v) {
    const r = snap.roles.find(x => x.rid === String(rid));
    if (!r || r.is_default) throw bad('invalid_roles');
    if (grantable && !snap.isOwner(me.id) && (r.position >= snap.top(me.id) || (Number(r.permissions) & P.ADMIN))) throw err('role_too_high', 403);
    if (!out.includes(r.rid)) out.push(r.rid);
  }
  return out;
}

const SECTION_RULES = {
  join: {
    allowlist: v => strList(v, { max: 1000, len: 64, code: 'invalid_allowlist', re: /^[\w.:-]+$/ }),
    max_members: v => int(v, 1, 1e7, 'invalid_max_members', true),
    default_roles: (v, ctx) => roleList(v, ctx.snap, ctx.me, { grantable: true }),
  },
  messages: {
    max_length: v => int(v, 1, MSG_MAX, 'invalid_max_length'),
    search_results: v => int(v, 1, 100, 'invalid_search_results'),
    max_reactions: v => int(v, 1, 50, 'invalid_max_reactions'),
    link_previews: v => bool(v, 'invalid_link_previews'),
    preview_proxy: v => httpUrl(v, 'invalid_preview_proxy'),
  },
  automod: {
    words_enabled: v => bool(v, 'invalid_automod'),
    words: v => strList(v, { max: 1000, len: 64, code: 'invalid_words', lower: false }),
    word_file: v => dataFile(v, 'invalid_word_file'),
    whole_word: v => bool(v, 'invalid_automod'),
    match_case: v => bool(v, 'invalid_automod'),
    timeout_seconds: v => int(v, 0, 28 * 86400, 'invalid_timeout'),
    exempt_roles: (v, ctx) => roleList(v, ctx.snap, ctx.me, { grantable: false }),
    spam_enabled: v => bool(v, 'invalid_automod'),
    spam_per_minute: v => int(v, 1, 600, 'invalid_spam_limits', true),
    spam_burst: v => int(v, 1, 100, 'invalid_spam_limits', true),
    spam_pause_seconds: v => int(v, 0, 86400, 'invalid_spam_limits', true),
  },
  audit: {
    enabled: v => bool(v, 'invalid_audit'),
    retention_days: v => int(v, 1, 3650, 'invalid_retention'),
    retention: v => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('invalid_retention');
      const out = {};
      for (const [k, d] of Object.entries(v)) { if (!AUDIT_CATEGORIES.includes(k)) throw bad('invalid_retention'); if (d !== null) out[k] = int(d, 1, 3650, 'invalid_retention'); }
      return out;
    },
  },
  uploads: {
    per_minute: v => int(v, 1, 600, 'invalid_uploads_per_minute'),
    files_per_member: v => int(v, 1, 1e6, 'invalid_files_per_member', true),
    types: v => { const t = strList(v, { max: FILE_TYPES.length, len: 12, code: 'invalid_file_types' }); if (t.some(x => !FILE_TYPES.includes(x))) throw bad('invalid_file_types'); return !t.length || t.includes('any') ? ['any'] : t; },
    expire_days: v => int(v, 1, 3650, 'invalid_expire_days', true),
    never_expire_plans: v => strList(v, { max: 10, len: 24, code: 'invalid_plans', re: /^[a-z0-9_-]+$/ }),
    never_expire_roles: (v, ctx) => roleList(v, ctx.snap, ctx.me, { grantable: false }),
    storage_mb: v => int(v, 1, 1e8, 'invalid_storage_mb', true),
    compress: v => bool(v, 'invalid_compress'),
    max_width: v => int(v, 16, 16384, 'invalid_image_size'),
    max_height: v => int(v, 16, 16384, 'invalid_image_size'),
    max_pixels: v => int(v, 10000, 1e9, 'invalid_image_size'),
    jpeg_quality: v => int(v, 1, 100, 'invalid_jpeg_quality'),
  },
};
const ADMIN_ONLY = { messages: ['preview_proxy'], automod: ['word_file'] };
const JOIN_POLICIES = ['open', 'request', 'password', 'allowlist', 'invite'];

// body: { join_policy?, join_password?, join?: {...}, messages?: {...}, automod?: {...}, audit?: {...}, uploads?: {...} }
// -> { changed: [section or key names] }. Throws API errors; nothing is saved unless all of it is valid.
async function update(c, snap, me, body = {}) {
  const auth = require('./auth');
  const cur = raw(c), next = JSON.parse(JSON.stringify(cur)), changed = new Set(), ctx = { snap, me };
  const admin = auth.isAdmin(me);
  for (const sec of SECTIONS) {
    const patch = body[sec];
    if (patch === undefined) continue;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('invalid_' + sec);
    for (const [k, v] of Object.entries(patch)) {
      const rule = SECTION_RULES[sec][k];
      if (!rule) continue; // unknown keys are ignored (older / newer clients)
      const val = rule(v, ctx);
      if (JSON.stringify(val) === JSON.stringify(cur[sec][k])) continue;
      if (ADMIN_ONLY[sec]?.includes(k) && !admin) throw err('instance_admin_only', 403, { setting: k });
      next[sec][k] = val; changed.add(sec);
    }
  }
  const p = planCaps(); // a number above the plan is saved as the plan's (the page shows the plan's number and a lock)
  if (p.member_cap != null && (next.join.max_members == null || next.join.max_members > p.member_cap)) next.join.max_members = p.member_cap;
  let policy = c.join_policy;
  if (body.join_password !== undefined) {
    if (body.join_password === null || body.join_password === '') { if (next.join.password_hash) { delete next.join.password_hash; changed.add('join_password'); } }
    else {
      if (typeof body.join_password !== 'string' || body.join_password.length < 4 || body.join_password.length > 200) throw bad('invalid_join_password');
      next.join.password_hash = await auth.hashPassword(body.join_password); changed.add('join_password');
    }
  }
  if (body.join_policy !== undefined) {
    if (!JOIN_POLICIES.includes(body.join_policy)) throw bad('invalid_join_policy');
    if (body.join_policy !== policy) { policy = body.join_policy; changed.add('join_policy'); }
  }
  if (policy === 'password' && !next.join.password_hash) throw bad('join_password_required');
  if (!changed.size) return { changed: [] };
  db.run('UPDATE communities SET settings = ?, join_policy = ? WHERE id = ?', JSON.stringify(next), policy, c.id);
  c.settings = JSON.stringify(next); c.join_policy = policy;
  if (changed.has('audit')) require('./audit').prune();
  return { changed: [...changed] };
}

// ---------- export / import (PROTOCOL §9) ----------
// what an export carries: everything but the join password and the two settings that point at this machine
function exportable(c) {
  const s = raw(c);
  delete s.join.password_hash; delete s.messages.preview_proxy; delete s.automod.word_file;
  return s;
}
// an export's settings -> what gets saved (each value checked like a PATCH; a bad one is left at its default). mapRid: old rid -> new
function imported(obj, mapRid) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  const roles = v => (Array.isArray(v) ? [...new Set(v.map(x => mapRid(String(x))).filter(Boolean))].slice(0, 25) : []);
  for (const sec of SECTIONS) {
    const src = obj[sec];
    if (!src || typeof src !== 'object') continue;
    out[sec] = {};
    for (const [k, v] of Object.entries(src)) {
      if ((sec === 'messages' && k === 'preview_proxy') || (sec === 'automod' && k === 'word_file')) continue;
      if ((sec === 'join' && k === 'default_roles') || (sec === 'automod' && k === 'exempt_roles') || (sec === 'uploads' && k === 'never_expire_roles')) { out[sec][k] = roles(v); continue; }
      const rule = SECTION_RULES[sec][k];
      if (!rule) continue;
      try { out[sec][k] = rule(v, {}); } catch { /* keep the default */ }
    }
  }
  return out;
}

// ---------- AutoMod word list file (cached by mtime) ----------
let fileCache = { path: null, mtime: 0, words: [] };
function fileWords(rel) {
  const abs = wordFilePath(rel);
  if (!abs) return [];
  try {
    const st = fs.statSync(abs);
    if (fileCache.path === abs && fileCache.mtime === st.mtimeMs) return fileCache.words;
    if (st.size > 2 * 1024 * 1024) return [];
    const words = fs.readFileSync(abs, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && l.length <= 64).slice(0, 20000);
    fileCache = { path: abs, mtime: st.mtimeMs, words };
    return words;
  } catch { return []; }
}

module.exports = { exportable, imported, DEFAULTS, SPAM_DEFAULTS, AUDIT_CATEGORIES, FILE_TYPES, JOIN_POLICIES, raw, get, view, update, fileWords, planCaps };
