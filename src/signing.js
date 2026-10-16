'use strict';
// Message signing (PROTOCOL §8): canonical JSON, payload build, verification against Velora device keys.
const crypto = require('crypto');
const config = require('./config');
const { fromB64url, normalizeOrigin } = require('./util');

const PREFIX = 'bonfire-msg-v1\n';
const KEY_TTL = 10 * 60 * 1000;
const SKEW = 5 * 60 * 1000;

// JSON with object keys sorted recursively, no whitespace, numbers as integers
function canonical(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite number');
    return String(Math.trunc(v));
  }
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

function buildPayload({ iss, instance, community, channel, author, ts, nonce, body, attachments = [], reply_to = null, edit_of = null }) {
  return {
    v: 1, iss, instance, community, channel, author: String(author), ts: Number(ts), nonce: String(nonce), body: String(body),
    attachments: attachments.map(String), reply_to: reply_to == null ? null : String(reply_to), edit_of: edit_of == null ? null : String(edit_of),
  };
}
const signingBytes = payload => Buffer.from(PREFIX + canonical(payload), 'utf8');

// ---- key lookup (injectable for tests) ----
const defaultFetchKey = async kid => {
  const url = `${config.get().velora_url}/bonfire/keys/kid/${encodeURIComponent(kid)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('key lookup ' + r.status);
  return r.json();
};
let fetchKey = defaultFetchKey;
const keyCache = new Map(); // kid -> { at, key }
const setKeyFetcher = fn => { fetchKey = fn || defaultFetchKey; keyCache.clear(); };

async function lookupKey(kid, nowMs) {
  const hit = keyCache.get(kid);
  if (hit && nowMs - hit.at < KEY_TTL) return hit.key;
  let key = null;
  try { key = await fetchKey(kid); } catch (e) { console.error('[signing] key fetch failed:', e.message); return undefined; }
  if (key) { keyCache.set(kid, { at: nowMs, key }); if (keyCache.size > 5000) keyCache.delete(keyCache.keys().next().value); }
  return key;
}

function publicKeyOf(b64) {
  const raw = fromB64url(b64);
  if (raw.length !== 32) return null;
  try { return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' }); } catch { return null; }
}

// -> { ok: true } | { ok: false, reason }
async function verify({ payload, signature, veloraId, now = Date.now() }) {
  if (!signature || typeof signature !== 'object' || typeof signature.kid !== 'string' || typeof signature.sig !== 'string') return { ok: false, reason: 'malformed' };
  if (Number(signature.ts) !== payload.ts || String(signature.nonce) !== payload.nonce) return { ok: false, reason: 'mismatch' };
  if (!Number.isFinite(payload.ts) || Math.abs(payload.ts - now) > SKEW) return { ok: false, reason: 'timestamp' };
  const key = await lookupKey(signature.kid, now);
  if (!key) return { ok: false, reason: key === undefined ? 'key_unavailable' : 'unknown_key' };
  if (String(key.user_id) !== String(veloraId)) return { ok: false, reason: 'wrong_user' };
  if (key.revoked_at != null && Number(key.revoked_at) < payload.ts) return { ok: false, reason: 'revoked' };
  const pub = publicKeyOf(key.public_key);
  if (!pub) return { ok: false, reason: 'bad_key' };
  const sig = fromB64url(signature.sig);
  if (sig.length !== 64) return { ok: false, reason: 'bad_signature' };
  let ok = false;
  try { ok = crypto.verify(null, signingBytes(payload), pub, sig); } catch { ok = false; }
  return ok ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

const issuer = () => normalizeOrigin(config.get().velora_url);

module.exports = { canonical, buildPayload, signingBytes, verify, setKeyFetcher, issuer, PREFIX };
