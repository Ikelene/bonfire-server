'use strict';
// Bot gallery on the instance (see Velora /opt/velora/BOT-GALLERY.md, PROTOCOL §14.1).
// A gallery bot is a normal instance bot (principal b:<n>, BOT tag, member of the community) whose profile and token HASH come
// from Velora: the person asks Velora for an add-ticket (EdDSA JWS, typ bonfire-botadd+jwt, aud = this instance, sub = the person),
// hands it to POST /api/v1/bots/gallery/add, and the instance creates the local bot after checking the ticket offline against
// Velora's JWKS. The bot's developer then connects to THIS instance's /bot/gateway with the same token they use everywhere
// (the token hash is stored here, so authentication stays local). Every few minutes `sync()` tells Velora which gallery bots we
// have (install counts, "trusted in N servers") and Velora answers with fresh profiles / token hashes, or "revoked" (banned,
// purged or deleted), which removes the bot from the community.
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const C = require('../communities');
const { P } = require('../perms');
const client = require('./client');
const { err, normalizeOrigin, now } = require('../util');

const TYP = 'bonfire-botadd+jwt', SYNC_MS = 10 * 60 * 1000, NAME = /^[A-Za-z0-9_.-]{2,32}$/;
const B = () => require('../bots');
let tick = null, soon = null, busy = false, dirty = false;
const trusted = new Map(); // gallery id -> "trusted in N servers" as of the last sync
const trustedIn = gid => (trusted.has(String(gid)) ? trusted.get(String(gid)) : null);

// ---------- ticket (checked offline) ----------
async function verifyTicket(token, user) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || token.length > 8192) throw err('ticket_invalid');
  let head, claims;
  try { head = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw err('ticket_invalid'); }
  if (head?.alg !== 'EdDSA' || head.typ !== TYP || typeof head.kid !== 'string' || !claims || typeof claims !== 'object') throw err('ticket_invalid');
  let key;
  try { key = await auth.keyFor(head.kid); } catch { throw err('velora_unreachable', 502); }
  if (!key) throw err('ticket_unknown_kid');
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url')); } catch { ok = false; }
  if (!ok) throw err('ticket_bad_signature');
  const cfg = config.get();
  if (normalizeOrigin(claims.iss) !== normalizeOrigin(cfg.velora_url)) throw err('ticket_wrong_issuer');
  if (normalizeOrigin(claims.aud) !== normalizeOrigin(cfg.public_url)) throw err('ticket_wrong_audience');
  if (!user.velora_id || String(claims.sub) !== String(user.velora_id)) throw err('ticket_wrong_user', 403);
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 < now()) throw err('ticket_expired', 410);
  const b = claims.bot;
  if (!b || !/^[1-9]\d{0,19}$/.test(String(b.id)) || typeof b.username !== 'string' || typeof claims.token_hash !== 'string' || !/^[0-9a-f]{64}$/.test(claims.token_hash) || typeof claims.jti !== 'string') throw err('ticket_invalid');
  if (!db.run('INSERT OR IGNORE INTO jti_seen (jti, exp) VALUES (?, ?)', claims.jti, claims.exp).changes) throw err('ticket_used', 409);
  return claims;
}

// ---------- local bot rows ----------
const httpsUrl = u => { try { const x = new URL(String(u)); return x.protocol === 'https:' || (x.protocol === 'http:' && process.env.BONFIRE_DEV === '1') ? x.href.slice(0, 512) : null; } catch { return null; } };
function freeName(want, gid, exceptId = 0) {
  const base = NAME.test(want) ? want : 'bot-' + gid;
  for (const n of [base, `${base.slice(0, 26)}-${gid}`.slice(0, 32)]) {
    // the bot's own Velora identity (registry bot id = Velora user id, principal v:<gid>) is not a clash: it is the same name, e.g. Jarvis' old messages
    if (!db.get("SELECT 1 FROM users WHERE LOWER(username) = ? AND id <> ? AND principal <> ?", n.toLowerCase(), exceptId, 'v:' + gid)) return n;
  }
  return `gb-${gid}-${crypto.randomBytes(2).toString('hex')}`.slice(0, 32);
}
const byGallery = gid => db.get('SELECT b.*, u.username FROM bots b JOIN users u ON u.id = b.user_id WHERE b.gallery_id = ?', String(gid));

async function add(me, body = {}) {
  if (!me.velora_id) throw err('gallery_needs_velora_account', 400);
  const { c, snap } = C.memberCommunity(String(body.sid || ''), me);
  if (!snap.can(me.id, P.MANAGE_SERVER)) throw err('not_allowed', 403);
  const claims = await verifyTicket(body.ticket, me);
  const gid = String(claims.bot.id);
  let row = byGallery(gid);
  if (row && snap.isMember(row.user_id)) throw err('already_in_server');
  if (row && db.get('SELECT 1 FROM bans WHERE community_id = ? AND user_id = ?', c.id, row.user_id)) throw err('banned_from_server', 403);
  const clash = db.get('SELECT user_id FROM bots WHERE token_hash = ? AND (gallery_id IS NULL OR gallery_id <> ?)', claims.token_hash, gid);
  if (clash) throw err('token_conflict', 409);
  const pfp = httpsUrl(claims.bot.avatar_url);
  const desc = String(claims.bot.description || '').slice(0, 300);
  require('../managed').assertRoom('bots', require('../managed').botCount(c.id));
  if (!row) {
    const name = freeName(String(claims.bot.username), gid);
    const id = db.tx(() => {
      const r = db.run("INSERT INTO users (principal, kind, username, display_name, username_lc, pfp, created_at) VALUES ('pending', 'bot', ?, ?, ?, ?, ?)", name, String(claims.bot.username).slice(0, 32), name.toLowerCase(), pfp, now());
      db.run('UPDATE users SET principal = ? WHERE id = ?', 'b:' + r.lastInsertRowid, r.lastInsertRowid);
      db.run('INSERT INTO bots (user_id, owner_id, token_hash, description, public, created_at, gallery_id, gallery_test, gallery_verified, gallery_active) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 1)',
        r.lastInsertRowid, me.id, claims.token_hash, desc, now(), gid, claims.test ? 1 : 0, claims.verified ? 1 : 0);
      return Number(r.lastInsertRowid);
    });
    row = byGallery(gid);
    if (!row) throw err('server_error', 500);
    void id;
  } else {
    db.run('UPDATE bots SET token_hash = ?, description = ?, gallery_verified = ?, gallery_active = 1, gallery_test = ? WHERE user_id = ?', claims.token_hash, desc, claims.verified ? 1 : 0, claims.test ? 1 : 0, row.user_id);
  }
  C.addMember(c, row.user_id);
  syncSoon();
  return { bot: B().viewOf(row.user_id) };
}

// ---------- sync with Velora ----------
function removeLocal(userId) {
  for (const m of db.all('SELECT community_id FROM members WHERE user_id = ?', userId)) C.removeMember(db.get('SELECT * FROM communities WHERE id = ?', m.community_id), userId, 'left');
  B().closeGatewaysOf(userId, 4004, 'removed from the gallery');
  db.run('DELETE FROM users WHERE id = ? AND kind = ?', userId, 'bot');
}
async function sync() {
  if (busy) { dirty = true; return null; }
  if (!client.registered()) return null;
  // only bots that are still members of the server count as installed: a kicked / banned gallery bot stops being reported (its Velora install count drops)
  const rows = db.all('SELECT user_id, gallery_id, gallery_test FROM bots WHERE gallery_id IS NOT NULL AND EXISTS (SELECT 1 FROM members m WHERE m.user_id = bots.user_id)');
  const reported = db.metaGet('gallery_reported') === '1';
  if (!rows.length && !reported) return null; // nothing local, nothing to take down on Velora
  busy = true;
  try {
    const out = await client.call('POST', '/bonfire/relay/bots/sync', { bots: rows.map(r => ({ id: r.gallery_id, test: !!r.gallery_test })) });
    db.metaSet('gallery_reported', rows.length ? '1' : '0');
    for (const x of Array.isArray(out?.bots) ? out.bots : []) {
      const row = byGallery(x.id);
      if (!row) continue;
      if (!db.get('SELECT 1 FROM members WHERE user_id = ?', row.user_id)) continue; // removed while request was in flight
      if (x.status === 'ok') {
        if (x.token_hash && x.token_hash !== row.token_hash) B().closeGatewaysOf(row.user_id, 4004, 'token rotated');
        if (Number.isInteger(x.trusted_in)) trusted.set(String(x.id), x.trusted_in);
        const pfp = httpsUrl(x.avatar_url);
        db.run('UPDATE bots SET token_hash = ?, description = ?, gallery_verified = ?, gallery_active = 1 WHERE user_id = ?', String(x.token_hash || row.token_hash), String(x.description || '').slice(0, 300), x.verified ? 1 : 0, row.user_id);
        if (pfp) db.run('UPDATE users SET pfp = ? WHERE id = ?', pfp, row.user_id);
        if (typeof x.username === 'string' && x.username.toLowerCase() !== String(row.username).toLowerCase()) {
          const name = freeName(x.username, row.gallery_id, row.user_id);
          db.run('UPDATE users SET username = ?, display_name = ?, username_lc = ? WHERE id = ?', name, x.username.slice(0, 32), name.toLowerCase(), row.user_id);
          auth.identityChanged(auth.userById(row.user_id), row.username);
        }
      } else if (x.status === 'revoked' || x.status === 'unknown') removeLocal(row.user_id);
    }
    return out;
  } catch (e) { return null; } finally { busy = false; if (dirty) { dirty = false; syncSoon(); } }
}
function syncSoon(ms = 3000) { dirty = busy || dirty; clearTimeout(soon); soon = setTimeout(() => { sync().catch(() => {}); }, ms); soon.unref?.(); }
function membershipRemoved() {
  // Force an empty report even if this install was removed before its first scheduled sync.
  db.metaSet('gallery_reported', '1');
  syncSoon();
}

function start() {
  tick = setInterval(() => { sync().catch(() => {}); }, SYNC_MS); tick.unref?.();
  client.events.on('registered', () => syncSoon(5000));
}
function stop() { clearInterval(tick); clearTimeout(soon); tick = soon = null; dirty = false; }

module.exports = { start, stop, add, sync, syncSoon, membershipRemoved, verifyTicket, trustedIn, TYP };
