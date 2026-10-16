'use strict';
// Paid roles in the roles shop (PROTOCOL §6.1, §12.5): a priced role becomes a Velora pay request, the person approves it
// on Velora, and the instance grants the role once it holds a valid EdDSA receipt (checked offline against Velora's JWKS).
// Purchases follow Velora's chat_role_purchases: once bought the role stays yours - take it off and put it back on for free;
// no refunds; deleting the role deletes the purchase.
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const auth = require('../auth');
const gateway = require('../gateway');
const C = require('../communities');
const { P } = require('../perms');
const { err, normalizeOrigin } = require('../util');
const client = require('./client');

const RECEIPT_TYP = 'bonfire-receipt+jwt';
const OPEN = "('creating','pending')";
let POLL_MS = 4000;

const purchased = (communityId, userId, roleId) => !!db.get('SELECT 1 FROM role_purchases WHERE community_id = ? AND user_id = ? AND role_id = ?', communityId, userId, roleId);
const view = pr => pr && ({ id: pr.pay_id, status: pr.status === 'creating' ? 'pending' : pr.status, approve_url: pr.approve_url, amount: pr.amount, expires_at: pr.expires_at, ...(pr.error ? { error: pr.error } : {}) });

function shopItem(cid, me, rid) {
  const ctx = C.findChannel(cid, me);
  if (ctx.ch.type !== 'roles') throw err('not_a_shop');
  const item = (C.cfgOf(ctx.ch).items || []).find(i => i.rid === rid);
  const r = item && ctx.snap.roles.find(x => x.rid === item.rid);
  if (!r) throw err('role_not_found', 404);
  return { ...ctx, item, r, price: Number(item.price) || 0 };
}
const openAttempt = (userId, roleId) => db.get(`SELECT * FROM role_payments WHERE user_id = ? AND role_id = ? AND status IN ${OPEN} ORDER BY id DESC LIMIT 1`, userId, roleId);
const latestAttempt = (userId, roleId) => db.get('SELECT * FROM role_payments WHERE user_id = ? AND role_id = ? ORDER BY id DESC LIMIT 1', userId, roleId);
const setAttempt = (id, f) => db.run(`UPDATE role_payments SET ${Object.keys(f).map(k => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...Object.values(f), Date.now(), id);

// the shop view plus, per item, the open pay request (if any)
function shopView(cid, me) {
  const out = C.shopView(cid, me);
  const ch = db.get('SELECT * FROM channels WHERE cid = ?', String(cid).replace(/^#/, ''));
  for (const it of out.items) {
    if (it.owned || it.price <= 0) continue;
    const role = db.get('SELECT id FROM roles WHERE rid = ? AND community_id = ?', it.role.rid, ch.community_id);
    const pr = role && openAttempt(me.id, role.id);
    if (pr && pr.status === 'pending') it.pending = view(pr);
  }
  out.payments = me.kind !== 'velora' ? 'velora_required' : client.registered() ? 'velora' : 'unavailable';
  return out;
}

// POST /channels/:cid/shop/:rid
async function buy(cid, me, rid, body = {}) {
  const { c, snap, r, price } = shopItem(cid, me, rid);
  if (!price || snap.isOwner(me.id) || snap.roleIds(me.id).has(r.id) || purchased(c.id, me.id, r.id)) { C.shopRole(cid, me, rid, true); return shopView(cid, me); }
  if (Number(r.permissions) & P.ADMIN) throw err('shop_admin_role');
  if (body?.price != null && Number(body.price) !== price) throw err('price_changed', 409);
  if (me.kind !== 'velora' || !me.velora_id) throw err('velora_required', 402);
  if (!client.registered()) throw err('payment_unavailable', 402);
  const shopCh = db.get('SELECT id FROM channels WHERE cid = ?', String(cid).replace(/^#/, ''));
  // one open request per person + role (+ price): asking again hands back the same one
  let pr = db.tx(() => {
    const cur = openAttempt(me.id, r.id);
    if (cur && cur.amount === price && (!cur.expires_at || cur.expires_at > Date.now())) return cur;
    if (cur) setAttempt(cur.id, { status: 'expired' });
    const n = db.get('SELECT COUNT(*) AS n FROM role_payments WHERE user_id = ? AND role_id = ?', me.id, r.id).n + 1;
    const t = Date.now();
    const id = db.run("INSERT INTO role_payments (community_id, channel_id, user_id, role_id, amount, ref, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'creating', ?, ?)",
      c.id, shopCh?.id ?? null, me.id, r.id, price, `role:${r.rid}:v${me.velora_id}:${n}:${crypto.randomBytes(3).toString('hex')}`, t, t).lastInsertRowid;
    return db.get('SELECT * FROM role_payments WHERE id = ?', Number(id));
  });
  if (pr.status === 'creating') {
    let out;
    try {
      out = await client.call('POST', '/bonfire/relay/pay-request', { user_id: String(me.velora_id), amount: price, reason: `The ${r.name} role in ${c.name}`.slice(0, 200), ref: pr.ref });
    } catch (e) {
      // network trouble / rate limits keep the attempt (and its ref) for a retry; a refusal ends it
      if (!(e.code === 'velora_unreachable' || e.status === 429 || e.status >= 500)) setAttempt(pr.id, { status: 'failed', error: e.code || 'payment_failed' });
      throw err(e.code === 'velora_not_registered' || e.code === 'velora_off' ? 'payment_unavailable' : e.code || 'payment_failed', e.status === 503 ? 402 : e.status || 502, e.extra);
    }
    if (typeof out?.id !== 'string' || typeof out.approve_url !== 'string') { setAttempt(pr.id, { status: 'failed', error: 'velora_bad_response' }); throw err('payment_failed', 502); }
    setAttempt(pr.id, { status: 'pending', pay_id: out.id, approve_url: out.approve_url, expires_at: Number(out.expires_at) || Date.now() + 30 * 60 * 1000 });
    pr = db.get('SELECT * FROM role_payments WHERE id = ?', pr.id);
  }
  poll();
  return { ...shopView(cid, me), pending: true, pay_request: view(pr) };
}

// GET /channels/:cid/shop/:rid/status
async function status(cid, me, rid) {
  const { c, r } = shopItem(cid, me, rid);
  let pr = latestAttempt(me.id, r.id);
  if (pr?.status === 'pending') { await check(pr).catch(() => {}); pr = db.get('SELECT * FROM role_payments WHERE id = ?', pr.id); }
  const st = purchased(c.id, me.id, r.id) ? 'paid' : pr ? view(pr).status : 'none';
  return { status: st, pay_request: view(pr) || null, ...shopView(cid, me) };
}

// ---------- receipts (§12.5), verified offline ----------
// -> claims, or throws err(<why>)
async function verifyReceipt(token, pr, user) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || token.length > 4096) throw err('receipt_invalid');
  let head, claims;
  try { head = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw err('receipt_invalid'); }
  if (head?.alg !== 'EdDSA' || head.typ !== RECEIPT_TYP || typeof head.kid !== 'string' || !claims || typeof claims !== 'object') throw err('receipt_invalid');
  let key;
  try { key = await auth.keyFor(head.kid); } catch { throw err('velora_unreachable', 502); }
  if (!key) throw err('receipt_unknown_kid');
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url')); } catch { ok = false; }
  if (!ok) throw err('receipt_bad_signature');
  const cfg = config.get();
  if (normalizeOrigin(claims.iss) !== cfg.velora_url) throw err('receipt_wrong_issuer');
  if (normalizeOrigin(claims.aud) !== cfg.public_url) throw err('receipt_wrong_audience');
  if (String(claims.sub) !== String(user.velora_id)) throw err('receipt_wrong_user');
  if (claims.amount !== pr.amount) throw err('receipt_wrong_amount');
  if (claims.ref !== pr.ref) throw err('receipt_wrong_ref');
  if (String(claims.rcp) !== String(pr.pay_id)) throw err('receipt_wrong_request');
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 < Date.now()) throw err('receipt_expired');
  if (db.get('SELECT 1 FROM role_purchases WHERE rcp = ?', String(claims.rcp))) throw err('receipt_used');
  return claims;
}

function grant(pr, claims) {
  const c = db.get('SELECT * FROM communities WHERE id = ?', pr.community_id);
  const role = db.get('SELECT * FROM roles WHERE id = ?', pr.role_id);
  db.tx(() => {
    if (role) db.run('INSERT OR IGNORE INTO role_purchases (community_id, user_id, role_id, price, rcp, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', pr.community_id, pr.user_id, pr.role_id, pr.amount, String(claims.rcp), pr.ref, Date.now());
    if (role && db.get('SELECT 1 FROM members WHERE community_id = ? AND user_id = ?', pr.community_id, pr.user_id)) db.run('INSERT OR IGNORE INTO member_roles (community_id, user_id, role_id) VALUES (?, ?, ?)', pr.community_id, pr.user_id, pr.role_id);
    setAttempt(pr.id, { status: 'paid', error: null });
  });
  if (!c || !role) return;
  C.memberChanged(c, pr.user_id, 'role');
  gateway.pushToUser(pr.user_id, { type: 'chat_perms_changed', server: c.sid });
  const ch = pr.channel_id && db.get('SELECT cid FROM channels WHERE id = ?', pr.channel_id);
  gateway.pushToUser(pr.user_id, { type: 'chat_shop_update', server: c.sid, channel: ch?.cid || null, rid: role.rid, status: 'paid' });
}

// ask Velora about one pending request and act on the answer
async function check(pr) {
  if (!client.registered()) return;
  let out;
  try { out = await client.call('GET', `/bonfire/relay/pay-request/${encodeURIComponent(pr.pay_id)}`); } catch (e) {
    if (e.status === 404) setAttempt(pr.id, { status: 'failed', error: 'not_found' });
    return;
  }
  const fresh = db.get('SELECT * FROM role_payments WHERE id = ?', pr.id);
  if (!fresh || fresh.status !== 'pending') return;
  const user = auth.userById(fresh.user_id);
  if (out.status === 'paid') {
    try { grant(fresh, await verifyReceipt(out.receipt, fresh, user)); } catch (e) {
      if (e.code === 'velora_unreachable') return; // JWKS not reachable: try again next round
      setAttempt(fresh.id, { status: 'failed', error: e.code || 'receipt_invalid' });
      console.error(`[velora] rejected a pay receipt for request ${fresh.pay_id}: ${e.code || e.message}`);
    }
  } else if (out.status === 'declined' || out.status === 'expired') {
    setAttempt(fresh.id, { status: out.status, error: out.error ? String(out.error).slice(0, 60) : null });
    const ch = fresh.channel_id && db.get('SELECT cid FROM channels WHERE id = ?', fresh.channel_id);
    const c = db.get('SELECT sid FROM communities WHERE id = ?', fresh.community_id);
    const role = db.get('SELECT rid FROM roles WHERE id = ?', fresh.role_id);
    if (c && role) gateway.pushToUser(fresh.user_id, { type: 'chat_shop_update', server: c.sid, channel: ch?.cid || null, rid: role.rid, status: out.status });
  }
}

// background poller: runs only while requests are open
let timer = null, polling = false;
function poll() {
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    if (polling) return poll();
    polling = true;
    let more = false;
    try {
      // requests stay readable on Velora after they end; give up on ones a day past their expiry
      db.run("UPDATE role_payments SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at < ?", Date.now(), Date.now() - 24 * 3600 * 1000);
      db.run("UPDATE role_payments SET status = 'failed', error = 'not_sent', updated_at = ? WHERE status = 'creating' AND created_at < ?", Date.now(), Date.now() - 3600 * 1000);
      for (const pr of db.all("SELECT * FROM role_payments WHERE status = 'pending' ORDER BY id LIMIT 50")) await check(pr);
      more = !!db.get("SELECT 1 FROM role_payments WHERE status = 'pending' LIMIT 1");
    } catch (e) { if (!/closed|not open/i.test(e.message)) console.error('[velora] pay poll', e.message); } finally { polling = false; }
    if (more && running) poll();
  }, POLL_MS);
  timer.unref?.();
}
let running = false;
function start() { running = true; client.events.on('registered', poll); poll(); }
function stop() { running = false; clearTimeout(timer); timer = null; }

module.exports = { start, stop, buy, status, shopView, verifyReceipt, check, purchased, RECEIPT_TYP, _setPollMs: ms => { POLL_MS = ms; } };
