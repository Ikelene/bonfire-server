'use strict';
// Instance sessions, Velora instance-JWT login (PROTOCOL §2.2/§4), local accounts, principals, admin/owner helpers.
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const { err, normalizeOrigin, b64url, fromB64url, sha256, now, clean } = require('./util');

const SESSION_TTL = 30 * 24 * 3600 * 1000;
const SKEW_S = 60;

// ---------- users / principals ----------
// bots (principal b:<n>) carry bot: true so clients show the BOT tag
const userView = u => (u ? { id: u.principal, kind: u.kind, username: u.username, display_name: u.display_name, pfp: u.pfp || null, velora_id: u.velora_id || null, ...(u.kind === 'bot' ? { bot: true } : {}) } : null);
const userById = id => db.get('SELECT * FROM users WHERE id = ?', id);
const userByPrincipal = p => db.get('SELECT * FROM users WHERE principal = ?', String(p));

function upsertVeloraUser({ id, username, display_name, pfp }) {
  const principal = 'v:' + id;
  const un = clean(username, 64) || 'user' + id, dn = clean(display_name, 64) || un;
  const row = userByPrincipal(principal);
  if (row) {
    db.run('UPDATE users SET username = ?, display_name = ?, pfp = ?, last_login = ? WHERE id = ?', un, dn, pfp || null, now(), row.id);
    if (row.username !== un || row.display_name !== dn || (row.pfp || null) !== (pfp || null)) identityChanged(userById(row.id), row.username);
    return userById(row.id);
  }
  const r = db.run('INSERT INTO users (principal, kind, username, display_name, pfp, velora_id, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', principal, 'velora', un, dn, pfp || null, String(id), now(), now());
  return userById(r.lastInsertRowid);
}
// placeholder for a Velora user we've only heard of (import, BONFIRE_OWNER) - refreshed on their first login
function ensureVeloraPlaceholder(id, username, pfp) {
  const row = userByPrincipal('v:' + id);
  if (row) return row;
  const un = clean(username, 64) || 'user' + id;
  const r = db.run('INSERT INTO users (principal, kind, username, display_name, pfp, velora_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'v:' + id, 'velora', un, un, pfp || null, String(id), now());
  return userById(r.lastInsertRowid);
}

// a profile change (name / picture) reaches every community the person is in: chat_identity_update { user, previous_username }
function identityChanged(u, previousUsername) {
  const gw = require('./gateway');
  for (const m of db.all('SELECT community_id FROM members WHERE user_id = ?', u.id)) gw.emit(m.community_id, { type: 'chat_identity_update', user: userView(u), previous_username: previousUsername });
}

// ---------- sessions ----------
function createSession(userId, scopes) {
  const token = b64url(crypto.randomBytes(32));
  db.run('INSERT INTO sessions (hash, user_id, scopes, created_at, last_used) VALUES (?, ?, ?, ?, ?)', sha256(token), userId, JSON.stringify(scopes), now(), now());
  return token;
}
// -> { user, scopes, hash } | null
function resolveSession(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const hash = sha256(token);
  const s = db.get('SELECT * FROM sessions WHERE hash = ?', hash);
  if (!s) return null;
  const t = now();
  if (t - s.last_used > SESSION_TTL) { db.run('DELETE FROM sessions WHERE hash = ?', hash); return null; }
  const user = userById(s.user_id);
  if (!user) return null;
  // principals of the other account mode can no longer use the instance
  if (user.kind !== (config.mode() === 'velora' ? 'velora' : 'local')) return null;
  if (t - s.last_used > 3600 * 1000) db.run('UPDATE sessions SET last_used = ? WHERE hash = ?', t, hash);
  let scopes = []; try { scopes = JSON.parse(s.scopes); } catch { /* none */ }
  return { user, scopes, hash };
}
const revokeSession = token => { if (token) db.run('DELETE FROM sessions WHERE hash = ?', sha256(token)); };
const bearer = req => { const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || ''); return m ? m[1] : null; };
setInterval(() => { try { db.run('DELETE FROM sessions WHERE last_used < ?', now() - SESSION_TTL); db.run('DELETE FROM jti_seen WHERE exp < ?', Math.floor(now() / 1000) - 3600); } catch { /* db closed */ } }, 3600 * 1000).unref();

// ---------- Velora JWT ----------
let jwksFetcher = async () => {
  const url = `${config.get().velora_url}/.well-known/bonfire/jwks.json`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('jwks ' + r.status);
  return r.json();
};
const setJwksFetcher = fn => { jwksFetcher = fn; jwks = null; };
let jwks = null; // { at, keys: Map(kid -> KeyObject), forced }
const JWKS_TTL = 10 * 60 * 1000;

async function loadJwks() {
  const doc = await jwksFetcher();
  const keys = new Map();
  for (const k of doc?.keys || []) {
    if (k.kty !== 'OKP' || k.crv !== 'Ed25519' || !k.kid) continue;
    try { keys.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })); } catch { /* skip bad key */ }
  }
  jwks = { at: Date.now(), keys, forced: jwks?.forced || 0 };
}
async function keyFor(kid) {
  if (!jwks || Date.now() - jwks.at > JWKS_TTL) await loadJwks();
  let key = jwks.keys.get(kid);
  if (!key && Date.now() - (jwks.forced || 0) > 5000) { // unknown kid: refetch once (rate limited)
    const forced = Date.now();
    await loadJwks(); jwks.forced = forced;
    key = jwks.keys.get(kid);
  }
  return key;
}

const bad = code => err(code, 401);
// verifies signature, iss, aud, exp (60s skew) and jti replay. -> claims
async function verifyVeloraJwt(token, nowMs = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || token.length > 8192) throw bad('invalid_token');
  let header, claims;
  try { header = JSON.parse(fromB64url(parts[0]).toString()); claims = JSON.parse(fromB64url(parts[1]).toString()); } catch { throw bad('invalid_token'); }
  if (!header || header.alg !== 'EdDSA' || typeof header.kid !== 'string' || !claims || typeof claims !== 'object') throw bad('invalid_token');
  let key;
  try { key = await keyFor(header.kid); } catch (e) { console.error('[auth] JWKS fetch failed:', e.message); throw err('velora_unreachable', 502); }
  if (!key) throw bad('unknown_kid');
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(parts[0] + '.' + parts[1]), key, fromB64url(parts[2])); } catch { ok = false; }
  if (!ok) throw bad('invalid_signature');
  const cfg = config.get();
  if (normalizeOrigin(claims.iss) !== normalizeOrigin(cfg.velora_url)) throw bad('invalid_issuer');
  if (normalizeOrigin(claims.aud) !== normalizeOrigin(cfg.public_url)) throw bad('invalid_audience');
  const nowS = Math.floor(nowMs / 1000);
  if (!Number.isFinite(claims.exp) || claims.exp + SKEW_S < nowS) throw bad('token_expired');
  if (Number.isFinite(claims.iat) && claims.iat - SKEW_S > nowS) throw bad('invalid_token');
  if (typeof claims.jti !== 'string' || !claims.jti || typeof claims.sub !== 'string' || !/^[1-9]\d{0,19}$/.test(claims.sub)) throw bad('invalid_token');
  const fresh = db.run('INSERT OR IGNORE INTO jti_seen (jti, exp) VALUES (?, ?)', claims.jti, claims.exp).changes;
  if (!fresh) throw bad('token_replayed');
  return claims;
}

// ---------- login flows ----------
function finishLogin(user, scopes) {
  if (user.banned) throw err('banned', 403);
  return { session: createSession(user.id, scopes), user: userView(userById(user.id)) };
}
async function loginVelora(token) {
  if (config.mode() !== 'velora') throw err('wrong_accounts_mode', 400);
  const c = await verifyVeloraJwt(token);
  const scp = Array.isArray(c.scp) ? c.scp.filter(x => ['chat', 'voice', 'media', 'sign'].includes(x)) : [];
  if (!scp.includes('chat')) throw err('insufficient_scope', 403);
  const existing = userByPrincipal('v:' + c.sub);
  if (existing?.banned) throw err('banned', 403);
  const user = upsertVeloraUser({ id: c.sub, username: c.username, display_name: c.display_name, pfp: typeof c.pfp === 'string' ? c.pfp : null });
  return finishLogin(user, scp);
}

// ---------- local accounts ----------
const SCRYPT = { N: 16384, r: 8, p: 1 };
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, SCRYPT, (e, k) => (e ? rej(e) : res(k))));
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${(await scrypt(pw, salt)).toString('hex')}`;
}
async function checkPassword(pw, stored) {
  const [alg, , , , salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) { await scrypt(pw, Buffer.alloc(16)); return false; }
  const k = await scrypt(pw, Buffer.from(salt, 'hex'));
  const h = Buffer.from(hash, 'hex');
  return k.length === h.length && crypto.timingSafeEqual(k, h);
}
const USERNAME = /^[a-z0-9_.]{2,32}$/;
const LOCAL_SCOPES = ['chat', 'voice', 'media'];
const claimed = () => !!db.metaGet('owner_user_id');

async function registerLocal(username, password) {
  if (config.mode() !== 'local') throw err('wrong_accounts_mode', 400);
  if (config.get().registration !== 'open' && claimed()) throw err('registration_closed', 403);
  const name = String(username || '').trim().toLowerCase();
  if (!USERNAME.test(name)) throw err('invalid_username');
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw err('invalid_password');
  if (db.get("SELECT 1 FROM users WHERE kind IN ('local', 'bot') AND username_lc = ?", name)) throw err('username_taken', 409);
  const hash = await hashPassword(password);
  let id;
  try {
    id = db.tx(() => {
      const r = db.run("INSERT INTO users (principal, kind, username, display_name, username_lc, password_hash, created_at, last_login) VALUES ('pending', 'local', ?, ?, ?, ?, ?, ?)", name, name, name, hash, now(), now());
      db.run('UPDATE users SET principal = ? WHERE id = ?', 'l:' + r.lastInsertRowid, r.lastInsertRowid);
      return r.lastInsertRowid;
    });
  } catch (e) { if (/UNIQUE/.test(e.message)) throw err('username_taken', 409); throw e; }
  return finishLogin(userById(id), LOCAL_SCOPES);
}
async function loginLocal(username, password) {
  if (config.mode() !== 'local') throw err('wrong_accounts_mode', 400);
  const u = db.get("SELECT * FROM users WHERE kind = 'local' AND username_lc = ?", String(username || '').trim().toLowerCase());
  const ok = await checkPassword(String(password || '').slice(0, 200), u?.password_hash);
  if (!u || !ok) throw err('invalid_credentials', 401);
  db.run('UPDATE users SET last_login = ? WHERE id = ?', now(), u.id);
  return finishLogin(u, LOCAL_SCOPES);
}

// ---------- owner / admins ----------
const ownerRow = () => { const id = db.metaGet('owner_user_id'); return id ? userById(Number(id)) : null; };
const isOwner = u => !!u && String(db.metaGet('owner_user_id')) === String(u.id);
const isAdmin = u => !!u && (isOwner(u) || !!db.get('SELECT 1 FROM instance_admins WHERE user_id = ?', u.id));
function setOwner(userId) {
  db.metaSet('owner_user_id', String(userId));
  db.run('INSERT OR IGNORE INTO instance_admins (user_id) VALUES (?)', userId);
}

module.exports = {
  userView, userById, userByPrincipal, upsertVeloraUser, ensureVeloraPlaceholder,
  createSession, resolveSession, revokeSession, bearer,
  verifyVeloraJwt, setJwksFetcher, loginVelora, registerLocal, loginLocal, hashPassword, checkPassword,
  claimed, ownerRow, isOwner, isAdmin, setOwner, identityChanged, SESSION_TTL,
};
