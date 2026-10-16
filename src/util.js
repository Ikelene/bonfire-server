'use strict';
const crypto = require('crypto');

const err = (code, status = 400, extra) => Object.assign(new Error(code), { code, status, extra });

// scheme://host[:port], lowercase, default port dropped, no path/query (PROTOCOL §1). null when it isn't http(s).
function normalizeOrigin(url) {
  try {
    const u = new URL(String(url).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin; // WHATWG already lowercases scheme/host and drops default ports
  } catch { return null; }
}

const b64url = buf => Buffer.from(buf).toString('base64url');
const fromB64url = s => Buffer.from(String(s), 'base64url');
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const randHex = n => crypto.randomBytes(n).toString('hex');
const randId = prefix => prefix + randHex(5);
const now = () => Date.now();
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function setupCode() {
  const b = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += CROCKFORD[b[i] % 32];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
// Crockford is forgiving: case-insensitive, I/L -> 1, O -> 0, dashes/spaces ignored
const normCode = c => String(c || '').toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// sliding-window limiter: limiter(max, ms).hit(key) -> true while allowed
function limiter(max, ms) {
  const hits = new Map();
  let lastSweep = Date.now();
  return {
    hit(key) {
      const t = Date.now();
      if (t - lastSweep > 60000) { lastSweep = t; for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] > ms) hits.delete(k); }
      const list = (hits.get(key) || []).filter(x => t - x < ms);
      if (list.length >= max) { hits.set(key, list); return false; }
      list.push(t); hits.set(key, list);
      return true;
    },
  };
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

module.exports = { err, normalizeOrigin, b64url, fromB64url, sha256, randHex, randId, now, clean, setupCode, normCode, safeEqual, limiter, log, CROCKFORD };
