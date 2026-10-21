'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { tmpDir, api, wsClient, fakeIdp } = require('./helpers');
const { startServer } = require('../src/index');
const db = require('../src/db');
const auth = require('../src/auth');
const managed = require('../src/managed');
const C = require('../src/communities');
const gallery = require('../src/relay/gallery');
const client = require('../src/relay/client');
const voice = require('../src/voice');
const { presence } = require('../src/bot-presence');

Object.assign(process.env, { BONFIRE_MANAGED: '1', BONFIRE_PLAN: 'testing', BONFIRE_LIMITS: JSON.stringify({ bots: 1, custom_voice_keys: true }), BONFIRE_ACCOUNTS_MODE: 'velora', BONFIRE_OWNER: 'v:100', BONFIRE_PUBLIC_URL: 'http://chat.test', BONFIRE_VELORA_URL: 'http://velora.test' });
const dir = tmpDir(), sockets = [], idp = fakeIdp({ iss: 'http://velora.test', aud: 'http://chat.test' });
let inst, owner, sid, c, human, watcher;
const token = 'gallery.test-token';
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
function ticket(id = '80') {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const h = b64({ alg: 'EdDSA', typ: gallery.TYP, kid: idp.kid });
  const b = b64({ iss: 'http://velora.test', aud: 'http://chat.test', sub: '100', exp: Math.floor(Date.now() / 1000) + 300, jti: crypto.randomUUID(), token_hash: hash(token + id), bot: { id, username: 'gallery' + id } });
  return h + '.' + b + '.' + crypto.sign(null, Buffer.from(h + '.' + b), idp.privateKey).toString('base64url');
}
async function login(sub, username) {
  const r = await api(inst.url).post('/api/v1/auth/velora', { token: idp.mint({ sub, username }) });
  assert.equal(r.status, 200);
  return { ...r.body, a: api(inst.url, r.body.session) };
}
async function connect(useToken) {
  const ws = new WebSocket(inst.url.replace('http:', 'ws:') + '/bot/gateway'), frames = [];
  sockets.push(ws);
  ws.on('message', raw => frames.push(JSON.parse(raw)));
  const closed = new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
  await new Promise(resolve => ws.once('open', resolve));
  ws.send(JSON.stringify({ op: 2, d: { token: useToken } }));
  for (let i = 0; i < 100 && !frames.some(f => f.t === 'READY'); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(frames.some(f => f.t === 'READY'));
  return { ws, frames, closed };
}
test.before(async () => {
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart() {} });
  auth.setJwksFetcher(idp.jwks);
  owner = await login('100', 'owner'); human = await login('200', 'human');
  sid = (await owner.a.post('/api/v1/servers', { name: 'Testing', join_policy: 'open' })).body.server.sid;
  c = db.get('SELECT * FROM communities WHERE sid = ?', sid);
  watcher = await wsClient(inst.url).login(owner.session); sockets.push(watcher.ws);
});
test.after(async () => {
  for (const ws of sockets) ws.terminate();
  voice.setFetch(null); gallery.stop();
  await inst.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('kick frees a gallery seat, closes every gateway, reports uninstall promptly and reuses history on re-add', async () => {
  const realReg = client.registered, realCall = client.call, reports = [];
  client.registered = () => true;
  client.call = async (method, path, body) => { assert.equal(path, '/bonfire/relay/bots/sync'); reports.push(body); return { bots: [] }; };
  try {
    const added = await owner.a.post('/api/v1/bots/gallery/add', { sid, ticket: ticket() });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const uid = Number(added.body.bot.id.slice(2));
    const a = await connect(token + '80'), b = await connect(token + '80');
    await gallery.sync();
    assert.equal(managed.botCount(c.id), 1);
    const full = await owner.a.post('/api/v1/bots', { name: 'blocked' });
    assert.deepEqual(full.body, { error: 'plan_limit', what: 'bots', limit: 1, used: 1, plan: 'testing' });
    // Populate the stats cache before removal: the exposed bot count must still refresh immediately.
    await owner.a.get('/api/v1/instance/info');
    const kick = await owner.a.del(`/api/v1/servers/${sid}/members/b:${uid}`);
    assert.equal(kick.status, 200, JSON.stringify(kick.body));
    for (const conn of [a, b]) {
      assert.equal((await conn.closed).code, 4003);
      assert.ok(conn.frames.some(f => f.t === 'GUILD_DELETE' && f.d.id === String(c.id)));
    }
    assert.equal(presence.status(uid), 'offline');
    assert.equal(db.get('SELECT gallery_active FROM bots WHERE user_id = ?', uid).gallery_active, 0);
    assert.equal(require('../src/bots').fromHeader('Bot ' + token + '80'), null);
    assert.equal(managed.botCount(c.id), 0);
    assert.equal((await owner.a.get('/api/v1/bots')).body.used, 0);
    const info = (await owner.a.get('/api/v1/instance/info')).body;
    assert.equal(info.stats.bots, 0);
    assert.deepEqual(info.plan.limits.bots, { limit: 1, used: 0 });
    assert.equal(info.plan.name, 'testing');
    assert.equal(info.plan.features.bridges, false);
    await watcher.waitFor(f => f.type === 'chat_presence' && f.user_id === 'b:' + uid && f.presence === 'offline');
    for (let i = 0; i < 80 && reports.at(-1).bots.length; i++) await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(reports.at(-1), { bots: [] }, 'debounced sync submits authoritative empty install list');
    const readd = await owner.a.post('/api/v1/bots/gallery/add', { sid, ticket: ticket() });
    assert.equal(readd.status, 200, JSON.stringify(readd.body));
    assert.equal(readd.body.bot.id, 'b:' + uid);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM bots WHERE gallery_id = ?', '80').n, 1);
    assert.equal(db.get('SELECT gallery_active FROM bots WHERE user_id = ?', uid).gallery_active, 1);
    const again = await connect(token + '80');
    assert.equal((await owner.a.del(`/api/v1/servers/${sid}/members/b:${uid}?ban=1`)).status, 200);
    assert.equal((await again.closed).code, 4003);
    assert.equal((await owner.a.post('/api/v1/bots/gallery/add', { sid, ticket: ticket() })).body.error, 'banned_from_server');
    await owner.a.del(`/api/v1/servers/${sid}/bans/b:${uid}`);
    const local = (await owner.a.post('/api/v1/bots', { name: 'replacement' })).body;
    assert.ok(local.token);
    assert.equal((await owner.a.post('/api/v1/bots/by-name/replacement/add', { sid })).status, 200);
    const blocked = await owner.a.post('/api/v1/bots/gallery/add', { sid, ticket: ticket() });
    assert.equal(blocked.body.error, 'plan_limit', 'existing gallery rows must also pass the limit');
    const localConn = await connect(local.token);
    const rotated = await owner.a.post(`/api/v1/bots/${local.bot.id}/token`);
    assert.equal((await localConn.closed).code, 4004);
    const deleteConn = await connect(rotated.body.token);
    await owner.a.del(`/api/v1/bots/${local.bot.id}`);
    assert.equal((await deleteConn.closed).code, 4003);
    assert.ok(deleteConn.frames.some(f => f.t === 'GUILD_DELETE'));
    assert.equal(managed.botCount(c.id), 0);
  } finally { gallery.stop(); client.registered = realReg; client.call = realCall; }
});

test('kick, ban and leave remove human subscriptions, typing and active RTC sessions', async () => {
  await owner.a.patch('/api/v1/instance/settings', { voice: { cf_app_id: 'app', cf_app_secret: 'secret', cf_turn_key_id: 'key', cf_turn_token: 'token' } });
  let sessions = 0;
  voice.setFetch(async url => ({ ok: true, json: async () => /sessions\/new$/.test(url) ? { sessionId: String(++sessions) } : /generate-ice-servers$/.test(url) ? { iceServers: [] } : { tracks: [] } }));
  const ch = db.get("SELECT * FROM channels WHERE community_id = ? AND type = 'voice'", c.id), room = 'bf_' + ch.cid;
  const hu = auth.userByPrincipal(human.user.id);
  for (const action of ['kick', 'ban', 'leave']) {
    assert.equal((await human.a.post(`/api/v1/servers/${sid}/join`)).status, 200);
    const h = await wsClient(inst.url).login(human.session); sockets.push(h.ws);
    h.send({ type: 'chat_rtc_join', room, nonce: action });
    await h.waitFor(f => f.type === 'chat_rtc_joined' && f.nonce === action);
    h.send({ type: 'chat_rtc_connected', room });
    await watcher.waitFor(f => f.type === 'chat_voice_state' && f.users.some(u => u.id === human.user.id));
    const r = action === 'leave' ? await human.a.post(`/api/v1/servers/${sid}/leave`) : await owner.a.del(`/api/v1/servers/${sid}/members/${human.user.id}${action === 'ban' ? '?ban=1' : ''}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await h.waitFor(f => f.type === 'chat_server_removed');
    await h.waitFor(f => f.type === 'chat_rtc_left');
    assert.equal(voice.roomOf(h.ws), null);
    assert.equal(voice.rtcRooms.size, 0);
    assert.equal(voice.voiceIn.size, 0);
    assert.equal(db.get('SELECT 1 FROM members WHERE user_id = ?', hu.id), undefined);
    h.frames.length = 0;
    require('../src/gateway').emit(c.id, { type: 'removal_probe' });
    await new Promise(r => setTimeout(r, 30));
    assert.ok(!h.frames.some(f => f.type === 'removal_probe'));
    assert.ok(watcher.frames.some(f => f.type === 'chat_typing' && f.user_id === human.user.id && f.typing === false));
    h.close();
    if (action === 'ban') await owner.a.del(`/api/v1/servers/${sid}/bans/${human.user.id}`);
    watcher.frames.length = 0;
  }
});

test('a bot leaving through its API and gallery revocation both close gateways and remove presence', async () => {
  const realReg = client.registered, realCall = client.call;
  client.registered = () => true;
  try {
    for (const action of ['leave', 'revoke']) {
      const r = await owner.a.post('/api/v1/bots/gallery/add', { sid, ticket: ticket('81') });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const uid = Number(r.body.bot.id.slice(2)), conn = await connect(token + '81');
      if (action === 'leave') {
        const left = await fetch(`${inst.url}/bot/v1/users/@me/guilds/${c.id}`, { method: 'DELETE', headers: { Authorization: 'Bot ' + token + '81' } });
        assert.equal(left.status, 204);
      } else {
        client.call = async () => ({ bots: [{ id: '81', status: 'revoked' }] });
        await gallery.sync();
        assert.equal(db.get('SELECT 1 FROM bots WHERE user_id = ?', uid), undefined);
      }
      assert.equal((await conn.closed).code, 4003);
      assert.ok(conn.frames.some(f => f.t === 'GUILD_DELETE'));
      assert.equal(presence.status(uid), 'offline');
      assert.equal(managed.botCount(c.id), 0);
    }
  } finally { gallery.stop(); client.registered = realReg; client.call = realCall; }
});

test('removal during gallery sync cannot reactivate a bot and queues an empty report', async () => {
  const realReg = client.registered, realCall = client.call;
  client.registered = () => true;
  let reply;
  const reports = [];
  client.call = async (method, path, body) => {
    reports.push(body);
    if (reports.length === 1) return new Promise(resolve => { reply = resolve; });
    return { bots: [] };
  };
  try {
    const r = await owner.a.post('/api/v1/bots/gallery/add', { sid, ticket: ticket('82') });
    assert.equal(r.status, 200);
    const uid = Number(r.body.bot.id.slice(2));
    const syncing = gallery.sync();
    assert.ok(reply);
    C.removeMember(c, uid, 'kicked');
    reply({ bots: [{ id: '82', status: 'ok', token_hash: hash('stale-rotation') }] });
    await syncing;
    assert.equal(db.get('SELECT gallery_active FROM bots WHERE user_id = ?', uid).gallery_active, 0);
    for (let i = 0; i < 80 && reports.length < 2; i++) await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(reports.at(-1), { bots: [] });
    assert.equal(require('../src/bots').fromHeader('Bot ' + token + '82'), null);
  } finally { gallery.stop(); client.registered = realReg; client.call = realCall; }
});

test('membership removal during RTC allocation cannot recreate a voice session', async () => {
  await human.a.post(`/api/v1/servers/${sid}/join`);
  const h = await wsClient(inst.url).login(human.session); sockets.push(h.ws);
  const ch = db.get("SELECT * FROM channels WHERE community_id = ? AND type = 'voice'", c.id), room = 'bf_' + ch.cid;
  const pending = [], closed = [];
  voice.setFetch(async (url, init) => {
    if (/sessions\/new$/.test(url)) return new Promise(resolve => pending.push(() => resolve({ ok: true, json: async () => ({ sessionId: 'session' + pending.length }) })));
    if (/\/sessions\//.test(url) && init.method === 'GET') closed.push(url);
    return { ok: true, json: async () => ({ iceServers: [], tracks: [] }) };
  });
  h.send({ type: 'chat_rtc_join', room, nonce: 'race' });
  for (let i = 0; i < 100 && pending.length < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(pending.length, 2);
  await owner.a.del(`/api/v1/servers/${sid}/members/${human.user.id}`);
  pending.forEach(resolve => resolve());
  assert.equal((await h.waitFor(f => f.type === 'chat_error' && f.nonce === 'race')).error, 'not_a_member');
  assert.equal(voice.rtcRooms.size, 0);
  assert.equal(closed.length, 2, 'both allocated upstream sessions are closed');
  h.close();
});

test('zero numeric allowances use plan_feature; unlimited counts stay available', async () => {
  const before = process.env.BONFIRE_LIMITS;
  try {
    process.env.BONFIRE_LIMITS = JSON.stringify({ bots: 0, emojis: 0, sounds: 0, max_upload_mb: 0 });
    for (const what of ['bots', 'emojis', 'sounds', 'max_upload_mb']) {
      assert.throws(() => managed.assertRoom(what, 0), e => e.code === 'plan_feature' && e.status === 403 && e.extra.what === what && e.extra.limit === 0 && e.extra.plan === 'testing' && !!e.extra.message);
      assert.equal(managed.usage().limits[what].limit, 0);
    }
    const disabled = await owner.a.post('/api/v1/bots', { name: 'disabled' });
    assert.equal(disabled.status, 403);
    assert.deepEqual(disabled.body, { error: 'plan_feature', what: 'bots', limit: 0, plan: 'testing', message: 'This plan does not include bots.' });
    await owner.a.patch(`/api/v1/servers/${sid}`, { allow_uploads: false });
    const zeroUpload = await owner.a.post(`/api/v1/media/import?sid=${sid}`, { url: 'https://unused.test/image.png' });
    // Permission/setting checks still precede plan checks.
    assert.equal(zeroUpload.body.error, 'uploads_disabled');
    await owner.a.patch(`/api/v1/servers/${sid}`, { allow_uploads: true });
    const disabledUpload = await owner.a.post(`/api/v1/media/import?sid=${sid}`, { url: 'https://unused.test/image.png' });
    assert.equal(disabledUpload.status, 403);
    assert.equal(disabledUpload.body.error, 'plan_feature');
    assert.equal(disabledUpload.body.what, 'max_upload_mb');
    assert.equal((await api(inst.url).get('/api/v1/instance/info')).body.plan, undefined);
    assert.deepEqual((await owner.a.get('/api/v1/instance/settings')).body.plan, managed.usage());
    process.env.BONFIRE_LIMITS = JSON.stringify({ bots: null });
    managed.assertRoom('bots', 1e9);
    assert.deepEqual(managed.usage().limits.bots, { limit: null, used: 0 });
  } finally { process.env.BONFIRE_LIMITS = before; }
});
