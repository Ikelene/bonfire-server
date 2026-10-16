'use strict';
// Velora relays, instance side (PROTOCOL §12): a stub Velora built from Velora's own pure modules (bonfire-relay.js signature
// verification + receipts, bonfire-idp.js tokens / JWKS, bonfire-urlcheck.js url proof) - registration, signed requests,
// import, push, daily credits, paid roles, voice broker, directory, `velora_registration: "off"`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { zipSync, strToU8 } = require('fflate');
const { tmpDir, api, wsClient } = require('./helpers');

const VELORA_DIR = path.join(__dirname, '../..');
const haveVelora = fs.existsSync(path.join(VELORA_DIR, 'bonfire-relay.js'));
process.env.BONFIRE_IDP_KEY = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bf-idp-')), 'idp.key');
process.env.BONFIRE_DEV = '1';
delete process.env.BONFIRE_VELORA_REGISTRATION; // this file talks to its own stub Velora
delete process.env.BONFIRE_OWNER;

const R = haveVelora ? require(path.join(VELORA_DIR, 'bonfire-relay.js')) : null;
const idp = haveVelora ? require(path.join(VELORA_DIR, 'bonfire-idp.js')) : null;
const urlcheck = haveVelora ? require(path.join(VELORA_DIR, 'bonfire-urlcheck.js')) : null;
const T = { skip: haveVelora ? false : 'needs the Velora checkout next to bonfire-server' };

const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 5000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out waiting for ' + what); await sleep(25); }
}

// ---------------------------------------------------------------- the stub Velora
const V = {
  trusted: true, capped: false, voiceOn: true, calls: [], authFailures: [], instances: new Map(), nonces: new Map(), daily: new Set(),
  pays: new Map(), receiptMode: 'good', sessions: new Set(), heartbeats: [], tickets: new Map(), directory: [], seq: 0,
};
const relayCalls = route => V.calls.filter(c => c.route === route);
function receiptFor(pr, inst) {
  const good = { id: pr.id, instanceUrl: inst.url, userId: pr.user_id, amount: pr.amount, ref: pr.ref, paidAt: pr.paid_at };
  switch (V.receiptMode) {
    case 'wrong_aud': return R.signReceipt({ ...good, instanceUrl: 'https://elsewhere.example' });
    case 'wrong_amount': return R.signReceipt({ ...good, amount: pr.amount + 1 });
    case 'bad_sig': { // right claims, signed by a key that is not in the JWKS (same kid)
      const t = R.signReceipt(good).split('.');
      const other = crypto.generateKeyPairSync('ed25519').privateKey;
      return `${t[0]}.${t[1]}.${crypto.sign(null, Buffer.from(t[0] + '.' + t[1]), other).toString('base64url')}`;
    }
    case 'login_token': return idp.signInstanceToken({ id: pr.user_id, username: 'x' }, 2048, inst.url).token; // a login JWT is not a receipt
    default: return R.signReceipt(good);
  }
}
async function veloraHandler(req, res) {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const send = (status, obj, headers = {}) => { const b = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj)); res.writeHead(status, { 'Content-Type': Buffer.isBuffer(obj) ? 'application/zip' : 'application/json', ...headers }); res.end(b); };
  const body = () => { try { return raw.length ? JSON.parse(raw) : {}; } catch { return {}; } };
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && u.pathname === '/.well-known/bonfire/jwks.json') return send(200, idp.jwks());
  if (req.method === 'POST' && u.pathname === '/bonfire/instances/challenge') {
    const b = body(), url = idp.normalizeOrigin(b.url);
    if (!R.publicKeyObject(b.pubkey)) return send(400, { error: 'invalid_pubkey' });
    const nonce = crypto.randomBytes(24).toString('base64url');
    V.nonces.set(nonce, { pubkey: b.pubkey, url });
    return send(200, { nonce, expires_in: 300 });
  }
  if (req.method === 'POST' && u.pathname === '/bonfire/instances/register') { // mirrors routes/bonfire-identity.js
    const b = body(), url = idp.normalizeOrigin(b.url), ch = V.nonces.get(b.nonce);
    if (!ch || ch.pubkey !== b.pubkey || ch.url !== url) return send(400, { error: 'invalid_nonce' });
    V.nonces.delete(b.nonce);
    if (!R.verifyRegistration(b.pubkey, b.nonce, url, b.sig)) return send(401, { error: 'bad_signature' });
    if (!['velora', 'local'].includes(b.accounts_mode)) return send(400, { error: 'invalid_accounts_mode' });
    const keyHash = R.keyHashOf(b.pubkey);
    const bound = [...V.instances.values()].find(i => i.url === url);
    if (bound && bound.key_hash !== keyHash) return send(409, { error: 'url_taken' });
    if (!bound) { const proof = await urlcheck.verifyInstanceUrl(url, b.pubkey); if (!proof.ok) return send(403, { error: 'url_unverified', reason: proof.reason }); }
    V.instances.set(keyHash, { key_hash: keyHash, pubkey: b.pubkey, url, name: b.name, accounts_mode: b.accounts_mode, owner: req.headers.authorization || null });
    return send(200, { instance_id: keyHash, trusted: V.trusted, voice: { cap_minutes: V.trusted ? null : 3000, used_minutes: 7 } });
  }
  if (!u.pathname.startsWith('/bonfire/relay/')) return send(404, { error: 'not_found' });
  // signed instance request: Velora's own verifier (bonfire-relay.js verifySigned)
  const inst = V.instances.get(String(req.headers['x-bonfire-instance'] || ''));
  if (!inst) { V.authFailures.push('unknown_instance'); return send(401, { error: 'unknown_instance' }); }
  const v = R.verifySigned({ method: req.method, path: req.url, ts: req.headers['x-bonfire-ts'], sig: req.headers['x-bonfire-sig'], body: raw, pubkey: inst.pubkey });
  if (!v.ok) { V.authFailures.push(v.error); return send(v.status, { error: v.error }); }
  const route = `${req.method} ${u.pathname.replace('/bonfire/relay', '').replace(/\/pay-request\/.+$/, '/pay-request/:id')}`;
  const d = body();
  V.calls.push({ route, body: d, query: Object.fromEntries(u.searchParams), at: Date.now() });
  switch (route) {
    case 'POST /notify': return send(200, { delivered: true });
    case 'POST /daily': {
      if (!V.trusted) return send(403, { error: 'not_trusted' });
      const k = `${d.user_id}:${new Date().toISOString().slice(0, 10)}`;
      if (V.daily.has(k)) return send(200, { status: 'already' });
      V.daily.add(k); return send(200, { status: 'claimed', amount: 5 });
    }
    case 'POST /pay-request': {
      const prior = [...V.pays.values()].find(p => p.instance === inst.key_hash && p.ref === d.ref);
      if (prior) { if (prior.user_id !== d.user_id || prior.amount !== d.amount) return send(409, { error: 'ref_reused' }); return send(200, { id: prior.id, status: prior.status, approve_url: `http://velora.stub/payment/${prior.id}`, amount: prior.amount }); }
      if (!Number.isInteger(d.amount) || d.amount < 1) return send(400, { error: 'invalid_amount' });
      const id = 'pr' + ++V.seq;
      V.pays.set(id, { id, instance: inst.key_hash, user_id: d.user_id, amount: d.amount, ref: d.ref, reason: d.reason, status: 'pending' });
      return send(200, { id, status: 'pending', approve_url: `http://velora.stub/payment/${id}`, amount: d.amount, expires_at: Date.now() + 30 * 60000 });
    }
    case 'GET /pay-request/:id': {
      const pr = V.pays.get(decodeURIComponent(u.pathname.split('/').pop()));
      if (!pr || pr.instance !== inst.key_hash) return send(404, { error: 'not_found' });
      return send(200, { id: pr.id, status: pr.status, amount: pr.amount, ref: pr.ref, receipt: pr.status === 'paid' ? receiptFor(pr, inst) : null, ...(pr.status === 'paid' ? { paid_at: pr.paid_at } : {}) });
    }
    case 'POST /rtc/session': case 'POST /rtc/tracks': case 'GET /rtc/ice': {
      if (!V.voiceOn) return send(503, { error: 'voice_unavailable' });
      if (V.capped) return send(402, { error: 'voice_cap_reached', cap_minutes: 3000, used_minutes: 3001 });
      const voice = { cap_minutes: 3000, used_minutes: 12, over: false };
      if (route === 'GET /rtc/ice') return send(200, { iceServers: [{ urls: ['stun:broker.stub:3478'] }] });
      if (route === 'POST /rtc/session') { const id = 'bs' + ++V.seq; V.sessions.add(id); return send(200, { sessionId: id, voice }); }
      if (!V.sessions.has(d.sessionId)) return send(404, { error: 'session_not_found' });
      if (d.sessionDescription) return send(200, { sessionDescription: { type: 'answer', sdp: 'v=0\r\n' + 'a=y\r\n'.repeat(10) }, tracks: d.tracks.map(t => ({ mid: t.mid, trackName: t.trackName })) });
      return send(200, { sessionDescription: { type: 'offer', sdp: 'v=0\r\n' + 'a=z\r\n'.repeat(10) }, tracks: d.tracks.map((t, i) => ({ mid: String(10 + i), trackName: t.trackName, sessionId: t.sessionId })) });
    }
    case 'POST /rtc/renegotiate': return send(200, {});
    case 'POST /rtc/close': {
      if (Array.isArray(d.mids) && d.mids.length) return send(200, { tracks: [] });
      V.sessions.delete(d.sessionId); return send(200, { ok: true, voice: { cap_minutes: 3000, used_minutes: 13, over: false } });
    }
    case 'POST /rtc/heartbeat': V.heartbeats.push(d.sessionIds); return send(200, { alive: d.sessionIds.filter(s => V.sessions.has(s)).length, voice: { cap_minutes: 3000, used_minutes: 13, over: false } });
    case 'PUT /directory': V.directory.push(d); return send(200, { listed: d.listed });
    case 'GET /import/bundle': {
      const t = V.tickets.get(u.searchParams.get('ticket'));
      if (!t) return send(404, { error: 'ticket_invalid' });
      if (t.aud !== inst.url) return send(403, { error: 'ticket_wrong_instance' });
      if (t.status !== 'done') return send(409, { error: 'not_ready' });
      if (t.used) return send(410, { error: 'ticket_expired' });
      t.used = true;
      return send(200, t.zip);
    }
    default: return send(404, { error: 'not_found' });
  }
}

// the Discord-import bundle Velora would build (§12.6): structure only, no members / messages
function bundle() {
  const community = {
    name: 'Imported Guild', description: 'from discord', settings: { join_policy: 'open' }, categories: ['Text', 'Voice'],
    channels: [
      { cid: 'c1', name: 'general', type: 'text', category: 'Text', position: 0 },
      { cid: 'c2', name: 'Lounge', type: 'voice', category: 'Voice', position: 1, config: { user_limit: 0 } },
      { cid: 'c3', name: 'shop', type: 'roles', category: 'Text', position: 2, config: { items: [{ rid: 'r10', price: 50 }, { rid: 'r11', price: 20 }, { rid: 'r12', price: 0 }] } },
    ],
    roles: [{ rid: 'everyone', name: '@everyone', permissions: 1 | 256, is_default: true }, { rid: 'r10', name: 'VIP', position: 1 }, { rid: 'r11', name: 'Gold', position: 2 }, { rid: 'r12', name: 'Free', position: 3 }],
    emojis: [], invites: [],
  };
  return Buffer.from(zipSync({
    'manifest.json': strToU8(JSON.stringify({ format: 'bonfire-export-v1', source: 'http://velora.stub', source_kind: 'velora-import', exported_at: Date.now(), community: 'c' })),
    'community.json': strToU8(JSON.stringify(community)), 'members.jsonl': strToU8(''),
  }));
}

// ---------------------------------------------------------------- the instance
let velora, VURL, inst, IURL, dir;
let relay, client, push, shop, directory, broker, messages;
const SCOPES = 2048 | 16384 | 4096; // chat, voice, media
async function veloraUser(id, username) {
  const { token } = idp.signInstanceToken({ id, username }, SCOPES, IURL);
  const r = await api(IURL).post('/api/v1/auth/velora', { token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...r.body, a: api(IURL, r.body.session) };
}
let alice, bob, carol, sid, general, lounge, shopCid, roles;

test.before(async () => {
  if (!haveVelora) return;
  velora = http.createServer((req, res) => { veloraHandler(req, res).catch(e => { console.error(e); res.writeHead(500); res.end('{}'); }); });
  await new Promise(r => velora.listen(0, '127.0.0.1', r));
  VURL = `http://127.0.0.1:${velora.address().port}`;
  process.env.BASE_URL = VURL; // the stub's issuer
  const port = await freePort();
  IURL = `http://127.0.0.1:${port}`;
  Object.assign(process.env, { BONFIRE_ACCOUNTS_MODE: 'velora', BONFIRE_VELORA_URL: VURL, BONFIRE_PUBLIC_URL: IURL, BONFIRE_OWNER: 'v:2' });
  dir = tmpDir();
  const { startServer } = require('../src/index');
  ({ client } = relay = require('../src/relay'));
  push = require('../src/relay/push'); shop = require('../src/relay/shop'); directory = require('../src/relay/directory'); broker = require('../src/relay/broker'); messages = require('../src/messages');
  push._setWindow(400); shop._setPollMs(100); directory._setDebounce(50); broker._setHeartbeatMs(100);
  inst = await startServer({ dataDir: dir, port, host: '127.0.0.1', restart: () => {} });
});
test.after(async () => {
  if (!haveVelora) return;
  await inst?.close();
  velora?.close();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of ['BONFIRE_ACCOUNTS_MODE', 'BONFIRE_VELORA_URL', 'BONFIRE_PUBLIC_URL', 'BONFIRE_OWNER']) delete process.env[k];
});

test('registration: key in discovery, url proof, signed relay requests verify with Velora\'s verifier', T, async () => {
  const keyFile = path.join(dir, 'keys', 'instance.key');
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  const disc = (await api(IURL).get('/.well-known/bonfire')).body;
  assert.match(disc.instance_id, /^ik_[0-9a-f]{16}$/);
  assert.equal(R.keyHashOf(disc.instance_key), disc.instance_id); // same id scheme as Velora
  await until(() => client.registered(), 5000, 'registration');
  const rec = V.instances.get(disc.instance_id);
  assert.equal(rec.url, IURL);
  assert.equal(rec.accounts_mode, 'velora');
  alice = await veloraUser(2, 'alice'); // the BONFIRE_OWNER
  const s = (await alice.a.get('/api/v1/instance/settings')).body;
  assert.equal(s.velora_registration, 'auto');
  const { registration, velora_url, registered, instance_id, trusted, voice, last_error } = s.velora;
  assert.deepEqual({ registration, velora_url, registered, instance_id, trusted, voice, last_error }, { registration: 'auto', velora_url: VURL, registered: true, instance_id: disc.instance_id, trusted: true, voice: { cap_minutes: null, used_minutes: 7 }, last_error: null });
  // the stub refuses another key claiming this url, and a url whose discovery does not publish the key
  const other = crypto.generateKeyPairSync('ed25519');
  const pk = other.publicKey.export({ format: 'jwk' }).x;
  const reg = async url => {
    const ch = (await api(VURL).post('/bonfire/instances/challenge', { pubkey: pk, url })).body;
    return api(VURL).post('/bonfire/instances/register', { pubkey: pk, url, name: 'x', accounts_mode: 'local', nonce: ch.nonce, sig: crypto.sign(null, Buffer.from(R.registerMessage(ch.nonce, url)), other.privateKey).toString('base64url') });
  };
  assert.equal((await reg(IURL)).body.error, 'url_taken');
  assert.deepEqual((await reg(VURL)).body, { error: 'url_unverified', reason: 'bad_status' }); // no discovery document there
  // a signed call: verified by bonfire-relay.js verifySigned (path incl. query, body hash, replay)
  await client.call('GET', '/bonfire/relay/rtc/ice?x=1');
  assert.deepEqual(V.authFailures, []);
  // manual re-register (admins only)
  assert.equal((await alice.a.post('/api/v1/instance/velora/register', {})).body.velora.registered, true);
});

test('import from Velora: ticket -> signed bundle download -> zip importer', T, async () => {
  bob = await veloraUser(3, 'bob');
  const ticket = 'bit_' + crypto.randomBytes(32).toString('base64url');
  V.tickets.set(ticket, { aud: IURL, status: 'running', zip: bundle() });
  assert.equal((await bob.a.post('/api/v1/import/velora', { ticket })).status, 403); // not an instance admin
  assert.equal((await alice.a.post('/api/v1/import/velora', { ticket: 'nope' })).body.error, 'ticket_invalid');
  let r = await alice.a.post('/api/v1/import/velora', { ticket });
  assert.equal(r.status, 409); assert.equal(r.body.error, 'not_ready'); assert.equal(r.body.retry, true);
  const wrong = 'bit_' + crypto.randomBytes(32).toString('base64url');
  V.tickets.set(wrong, { aud: 'https://other.example', status: 'done', zip: bundle() });
  assert.equal((await alice.a.post('/api/v1/import/velora', { ticket: wrong })).body.error, 'ticket_wrong_instance');
  V.tickets.get(ticket).status = 'done';
  r = await alice.a.post('/api/v1/import/velora', { ticket });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  sid = r.body.sid;
  assert.equal(relayCalls('GET /import/bundle').at(-1).query.ticket, ticket);
  r = await alice.a.post('/api/v1/import/velora', { ticket }); // one community per instance
  assert.equal(r.body.error, 'community_exists');
  const d = (await alice.a.get(`/api/v1/servers/${sid}`)).body;
  assert.equal(d.server.name, 'Imported Guild');
  general = d.channels.find(c => c.name === 'general').cid; lounge = d.channels.find(c => c.type === 'voice').cid; shopCid = d.channels.find(c => c.type === 'roles').cid;
  roles = Object.fromEntries(d.roles.map(x => [x.name, x.rid]));
  assert.ok(roles.VIP && roles.Gold && roles.Free);
  assert.equal((await bob.a.post(`/api/v1/servers/${sid}/join`)).status, 200);
});

test('push: offline Velora members, coalesced per user + channel, never when connected', T, async () => {
  V.calls.length = 0;
  messages._sendLimit.reset?.();
  const post = text => alice.a.post(`/api/v1/channels/${general}/messages`, { message: text });
  await post('@bob first');
  await until(() => relayCalls('POST /notify').length === 1, 3000, 'first push');
  await post('@bob second'); await post('@bob third');
  await sleep(150);
  assert.equal(relayCalls('POST /notify').length, 1); // coalesced
  await until(() => relayCalls('POST /notify').length === 2, 3000, 'summary push');
  const [first, summary] = relayCalls('POST /notify').map(c => c.body);
  assert.deepEqual({ ...first, preview: undefined }, { user_id: '3', kind: 'mention', community_name: 'Imported Guild', channel_name: 'general', title: 'alice mentioned you', preview: undefined, url: `${IURL}/#/s/${sid}/${general}` });
  assert.equal(first.preview, '@bob first');
  assert.equal(summary.title, '2 new mentions in #general');
  assert.match(summary.preview, /third/);
  // connected: no push (the gateway delivers chat_mention instead)
  const wb = await wsClient(IURL).login(bob.session);
  await post('@bob are you there');
  await wb.waitFor(f => f.type === 'chat_mention');
  push.onOffline([db().get("SELECT id FROM users WHERE principal = 'v:3'").id], { id: 1, cid: 'cother', sid, server: 'x', channel: 'y', from: 'alice', body: 'hi' });
  await sleep(600);
  assert.equal(relayCalls('POST /notify').length, 2);
  wb.close();
});
const db = () => require('../src/db');

test('daily credits: first message of the UTC day, once, with the ephemeral notice; untrusted instances stop asking', T, async () => {
  V.calls.length = 0; V.daily.clear();
  messages._sendLimit.reset?.();
  require('../src/relay/daily').stop(); require('../src/relay/daily').start(); // forget earlier messages of this run
  const wb = await wsClient(IURL).login(bob.session);
  await bob.a.post(`/api/v1/channels/${general}/messages`, { message: 'good morning' });
  const eph = await wb.waitFor(f => f.type === 'chat_ephemeral');
  assert.deepEqual(eph, { type: 'chat_ephemeral', server: sid, channel: general, kind: 'daily', amount: 5, body: 'You claimed your daily chat credits (+5 credits).' });
  await bob.a.post(`/api/v1/channels/${general}/messages`, { message: 'again' });
  await sleep(150);
  assert.deepEqual(relayCalls('POST /daily').map(c => c.body), [{ user_id: '3' }]);
  wb.close();
  // Velora stops trusting the instance: re-registration says so, and nobody's message asks any more
  V.trusted = false;
  await alice.a.post('/api/v1/instance/velora/register', {});
  carol = await veloraUser(4, 'carol');
  await carol.a.post(`/api/v1/servers/${sid}/join`);
  await carol.a.post(`/api/v1/channels/${general}/messages`, { message: 'hi' });
  await sleep(150);
  assert.equal(relayCalls('POST /daily').length, 1);
  assert.equal((await alice.a.get('/api/v1/instance/settings')).body.velora.trusted, false);
  V.trusted = true;
  await alice.a.post('/api/v1/instance/velora/register', {});
});

test('roles shop: pay request -> receipt verified offline -> role granted; bad receipts are refused', T, async () => {
  V.calls.length = 0;
  const wb = await wsClient(IURL).login(bob.session);
  let v = (await bob.a.get(`/api/v1/channels/${shopCid}/shop`)).body;
  assert.equal(v.payments, 'velora');
  assert.deepEqual(v.items.map(i => [i.role.name, i.price, i.owned]), [['VIP', 50, false], ['Gold', 20, false], ['Free', 0, true]]);
  // owner: free
  assert.equal((await alice.a.post(`/api/v1/channels/${shopCid}/shop/${roles.VIP}`)).body.items[0].has, true);
  assert.equal((await bob.a.post(`/api/v1/channels/${shopCid}/shop/${roles.VIP}`, { price: 40 })).body.error, 'price_changed');
  let r = await bob.a.post(`/api/v1/channels/${shopCid}/shop/${roles.VIP}`, { price: 50 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pending, true);
  assert.equal(r.body.pay_request.amount, 50);
  assert.match(r.body.pay_request.approve_url, /\/payment\/pr\d+$/);
  assert.ok(Array.isArray(r.body.items)); // still the shop view (client compatible)
  const payId = r.body.pay_request.id;
  const req1 = V.pays.get(payId);
  assert.equal(req1.user_id, '3'); assert.match(req1.ref, /^role:r[0-9a-f]{10}:v3:1:/); assert.match(req1.reason, /VIP/);
  // asking again: the same request (idempotent)
  r = await bob.a.post(`/api/v1/channels/${shopCid}/shop/${roles.VIP}`);
  assert.equal(r.body.pay_request.id, payId);
  assert.equal(V.pays.size, 1);
  assert.equal((await bob.a.get(`/api/v1/channels/${shopCid}/shop/${roles.VIP}/status`)).body.status, 'pending');
  assert.equal((await bob.a.get(`/api/v1/channels/${shopCid}/shop`)).body.items[0].pending.id, payId);
  // approved on Velora -> the poller verifies the receipt and grants the role
  Object.assign(req1, { status: 'paid', paid_at: Date.now() });
  const upd = await wb.waitFor(f => f.type === 'chat_member_update' && f.user_id === 'v:3', 4000);
  assert.ok(upd.member.roles.includes(roles.VIP));
  await wb.waitFor(f => f.type === 'chat_shop_update' && f.status === 'paid');
  const st = (await bob.a.get(`/api/v1/channels/${shopCid}/shop/${roles.VIP}/status`)).body;
  assert.equal(st.status, 'paid');
  assert.deepEqual([st.items[0].has, st.items[0].owned], [true, true]);
  // bought once: off and on again without paying
  v = (await bob.a.del(`/api/v1/channels/${shopCid}/shop/${roles.VIP}`)).body;
  assert.deepEqual([v.items[0].has, v.items[0].owned], [false, true]);
  v = (await bob.a.post(`/api/v1/channels/${shopCid}/shop/${roles.VIP}`)).body;
  assert.equal(v.items[0].has, true); assert.equal(v.pending, undefined);
  assert.equal(V.pays.size, 1);

  // bad receipts: wrong audience, wrong amount, bad signature, a login token -> never granted
  for (const [mode, why] of [['wrong_aud', 'receipt_wrong_audience'], ['wrong_amount', 'receipt_wrong_amount'], ['bad_sig', 'receipt_bad_signature'], ['login_token', 'receipt_invalid']]) {
    V.receiptMode = mode;
    r = await bob.a.post(`/api/v1/channels/${shopCid}/shop/${roles.Gold}`);
    assert.equal(r.body.pending, true, mode);
    const pr = V.pays.get(r.body.pay_request.id);
    Object.assign(pr, { status: 'paid', paid_at: Date.now() });
    const s2 = (await bob.a.get(`/api/v1/channels/${shopCid}/shop/${roles.Gold}/status`)).body;
    assert.equal(s2.status, 'failed', mode);
    assert.equal(s2.pay_request.error, why);
    assert.equal(s2.items[1].has, false);
  }
  V.receiptMode = 'good';
  // declined on Velora
  r = await bob.a.post(`/api/v1/channels/${shopCid}/shop/${roles.Gold}`);
  V.pays.get(r.body.pay_request.id).status = 'declined';
  assert.equal((await bob.a.get(`/api/v1/channels/${shopCid}/shop/${roles.Gold}/status`)).body.status, 'declined');
  // a receipt can only be used once (rcp)
  const used = db().get('SELECT rcp FROM role_purchases LIMIT 1').rcp;
  assert.equal(used, payId);
  wb.close();
});

test('voice: backend selection (own keys > Velora broker > none), heartbeats, cap error', T, async () => {
  V.calls.length = 0;
  const voice = require('../src/voice');
  await until(() => broker.available(), 3000, 'broker probe');
  assert.equal(voice.backendName(), 'broker');
  assert.equal((await api(IURL).get('/.well-known/bonfire')).body.features.voice, true);
  const room = 'bf_' + lounge;
  const wb = await wsClient(IURL).login(bob.session);
  const SDP = 'v=0\r\n' + 'a=x\r\n'.repeat(10);
  wb.send({ type: 'chat_rtc_join', nonce: 'j1', room });
  const joined = await wb.waitFor(f => f.type === 'chat_rtc_joined');
  assert.equal(joined.iceServers[0].urls[0], 'stun:broker.stub:3478');
  assert.equal(relayCalls('POST /rtc/session').length, 1); // the receive session is made lazily
  wb.send({ type: 'chat_rtc_publish', nonce: 'p1', room, sessionDescription: { type: 'offer', sdp: SDP }, tracks: [{ mid: '0', trackName: 'audio' }] });
  assert.deepEqual((await wb.waitFor(f => f.type === 'chat_rtc_published')).tracks.map(t => t.trackName), ['audio']);
  assert.deepEqual(relayCalls('POST /rtc/tracks')[0].body.tracks, [{ mid: '0', trackName: 'audio' }]);
  wb.send({ type: 'chat_rtc_connected', room });
  await until(() => V.heartbeats.length > 0, 2000, 'heartbeat');
  assert.equal(V.heartbeats.at(-1).length, 1);
  wb.send({ type: 'chat_rtc_leave', room });
  await until(() => relayCalls('POST /rtc/close').length === 1, 2000, 'close');
  assert.equal(V.sessions.size, 0);
  // the monthly cap: the joiner gets voice_cap_reached, discovery stops advertising voice
  V.capped = true;
  wb.send({ type: 'chat_rtc_join', nonce: 'j2', room });
  const e = await wb.waitFor(f => f.nonce === 'j2' && f.type === 'chat_error');
  assert.equal(e.error, 'voice_cap_reached');
  assert.equal((await api(IURL).get('/.well-known/bonfire')).body.features.voice, false);
  V.capped = false;
  // own Cloudflare keys win
  await alice.a.patch('/api/v1/instance/settings', { voice: { cf_app_id: 'a', cf_app_secret: 'b', cf_turn_key_id: 'c', cf_turn_token: 'd' } });
  assert.equal(voice.backendName(), 'direct');
  assert.equal((await alice.a.get('/api/v1/instance/settings')).body.velora.voice_backend, 'direct');
  await alice.a.patch('/api/v1/instance/settings', { voice: { cf_app_id: '', cf_turn_key_id: '' } });
  assert.equal(voice.backendName(), 'broker');
  wb.close();
});

test('directory: listed toggle pushes the listing, unlisting removes it', T, async () => {
  V.directory.length = 0;
  await alice.a.patch('/api/v1/instance/settings', { tags: ['Gaming', 'chat'] });
  assert.equal((await alice.a.patch(`/api/v1/servers/${sid}`, { listed: true })).status, 200);
  assert.equal((await alice.a.get('/api/v1/instance/settings')).body.listed, true); // same value as the community's
  await until(() => V.directory.length >= 1, 3000, 'directory push');
  const inv = (await alice.a.get(`/api/v1/servers/${sid}`)).body.server.invite;
  assert.deepEqual(V.directory.at(-1), { listed: true, name: 'Imported Guild', description: 'from discord', icon_url: null, member_count: 3, invite_url: `${VURL}/chat#/i/${encodeURIComponent(IURL)}/invite/${inv}`, tags: ['gaming', 'chat'] });
  assert.equal((await alice.a.get('/api/v1/instance/settings')).body.velora.directory.listed, true);
  const n = V.directory.length;
  await directory.push(); // nothing changed: no push
  assert.equal(V.directory.length, n);
  await alice.a.patch('/api/v1/instance/settings', { listed: false });
  await until(() => V.directory.at(-1)?.listed === false, 3000, 'unlisting');
  assert.deepEqual(V.directory.at(-1), { listed: false });
  assert.equal((await alice.a.get(`/api/v1/servers/${sid}`)).body.server.listed, false);
});

test('velora_registration "off": nothing contacts Velora; voice falls back to unavailable; "auto" registers again', T, async () => {
  await alice.a.patch('/api/v1/instance/settings', { velora_registration: 'off' });
  const s = (await alice.a.get('/api/v1/instance/settings')).body;
  assert.equal(s.velora.registered, false);
  assert.equal(s.velora.registration, 'off');
  V.calls.length = 0;
  const voice = require('../src/voice');
  assert.equal(voice.backendName(), null);
  assert.equal((await api(IURL).get('/.well-known/bonfire')).body.features.voice, false);
  const wb = await wsClient(IURL).login(bob.session);
  wb.send({ type: 'chat_rtc_join', nonce: 'j9', room: 'bf_' + lounge });
  assert.equal((await wb.waitFor(f => f.nonce === 'j9')).error, 'voice_unavailable');
  wb.close();
  await sleep(100);
  messages._sendLimit.reset?.();
  await alice.a.post(`/api/v1/channels/${general}/messages`, { message: '@bob offline?' });
  assert.equal((await bob.a.post(`/api/v1/channels/${shopCid}/shop/${roles.Gold}`)).body.error, 'payment_unavailable');
  await sleep(700);
  assert.deepEqual(V.calls, []);
  await alice.a.patch('/api/v1/instance/settings', { velora_registration: 'auto' });
  await until(() => client.registered(), 5000, 're-registration');
});
