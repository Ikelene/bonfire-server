'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const WebSocket = require('ws');
const { BotPresence, HEARTBEAT_TIMEOUT, presence } = require('../src/bot-presence');
const { startServer } = require('../src/index');
const db = require('../src/db');
const auth = require('../src/auth');
const C = require('../src/communities');
const { tmpDir, api, wsClient } = require('./helpers');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('registry: multiple READY connections, debounce, stale sweep and idempotent cleanup', async () => {
  const events = [], p = new BotPresence((...args) => events.push(args), 15);
  const connection = id => {
    const g = { botId: id, last: 100, ws: { readyState: 1, close() { this.readyState = 3; }, terminate() {} } };
    g.dispose = () => p.remove(g);
    return g;
  };
  try {
    assert.equal(p.status(1), 'offline');
    const a = connection(1), b = connection(1);
    p.add(a); p.add(a); p.add(b);
    assert.equal(p.status(1), 'online');
    await sleep(30);
    assert.deepEqual(events, [[1, 'online']]);
    p.remove(a); p.remove(a);
    await sleep(30);
    assert.equal(p.status(1), 'online');
    assert.equal(events.length, 1);
    p.remove(b); p.add(b); // a reconnect inside the debounce window
    await sleep(30);
    assert.equal(events.length, 1);
    p.sweep(100 + HEARTBEAT_TIMEOUT); // boundary still alive
    assert.equal(p.status(1), 'online');
    p.sweep(101 + HEARTBEAT_TIMEOUT);
    assert.equal(p.status(1), 'offline');
    await sleep(30);
    assert.deepEqual(events, [[1, 'online'], [1, 'offline']]);
    const c = connection(2);
    p.add(c); p.remove(c);
    await sleep(30);
    assert.equal(events.length, 2, 'never publishes a brief connection');
  } finally { p.clear(); }
});

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_OWNER;
const dir = tmpDir(), clients = [];
let inst, base, owner, outsider, sid, bot, token, human, other;
test.before(async () => {
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} });
  base = inst.url;
  const register = async username => {
    const r = await api(base).post('/api/v1/auth/register', { username, password: 'correct horse battery' });
    assert.equal(r.status, 200);
    return { ...r.body, a: api(base, r.body.session) };
  };
  owner = await register('owner'); outsider = await register('outsider');
  await owner.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  sid = (await owner.a.post('/api/v1/servers', { name: 'Camp' })).body.server.sid;
  const created = await owner.a.post('/api/v1/bots', { name: 'dotbot' });
  bot = created.body.bot; token = created.body.token;
  human = await wsClient(base).login(owner.session); clients.push(human.ws);
  other = await wsClient(base).login(outsider.session); clients.push(other.ws);
});
test.after(async () => {
  for (const ws of clients) ws.terminate();
  await inst.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function connect(status = 'invisible', useToken = token) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/bot/gateway');
  clients.push(ws);
  const frames = [];
  ws.on('message', raw => frames.push(JSON.parse(raw)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ op: 2, d: { token: useToken, presence: { status } } }));
  if (useToken === token) {
    for (let i = 0; i < 100 && !frames.some(f => f.t === 'READY'); i++) await sleep(10);
    assert.ok(frames.some(f => f.t === 'READY'));
  } else await new Promise(resolve => ws.once('close', resolve));
  return ws;
}
const members = async () => (await owner.a.get(`/api/v1/servers/${sid}/members`)).body.members;
const botMember = async () => (await members()).find(m => m.id === bot.id);
const close = ws => new Promise(resolve => { ws.once('close', resolve); ws.close(); });

test('READY -> online, join payload, gallery rows, member-only events, multiple connections -> offline', async () => {
  const uid = Number(bot.id.slice(2));
  await connect('online', 'invalid');
  assert.equal(presence.status(uid), 'offline', 'failed authentication does not count');
  const a = await connect(); // unsupported invisible must not hide a live connection
  assert.equal(presence.status(uid), 'online');
  await owner.a.post('/api/v1/bots/by-name/dotbot/add', { sid });
  const joined = await human.waitFor(f => f.type === 'chat_member_update' && f.user_id === bot.id && f.change === 'joined');
  assert.equal(joined.member.presence, 'online');
  assert.equal((await botMember()).presence, 'online');
  assert.equal((await members()).find(m => m.id === owner.user.id).presence, null);
  const online = await human.waitFor(f => f.type === 'chat_presence' && f.user_id === bot.id);
  assert.deepEqual(online, { type: 'chat_presence', server: sid, user_id: bot.id, username: 'dotbot', presence: 'online' });
  assert.equal((await outsider.a.get(`/api/v1/servers/${sid}/members`)).status, 403);
  assert.ok(!other.frames.some(f => f.type === 'chat_presence'));
  assert.equal(Object.hasOwn(auth.userView(auth.userById(uid)), 'presence'), false, 'generic user views do not leak status');

  db.run('UPDATE bots SET gallery_id = ? WHERE user_id = ?', '12345', uid);
  assert.equal((await botMember()).presence, 'online', 'gallery bot uses the same local connection registry');
  const b = await connect('offline');
  b.send(JSON.stringify({ op: 3, d: { status: 'invisible' } }));
  await close(a);
  await sleep(2100);
  assert.equal((await botMember()).presence, 'online');
  assert.equal(human.frames.filter(f => f.type === 'chat_presence').length, 1);
  await close(b);
  assert.equal((await botMember()).presence, 'offline');
  await human.waitFor(f => f.type === 'chat_presence' && f.presence === 'offline');
  assert.ok(!other.frames.some(f => f.type === 'chat_presence'));
});

test('socket errors drop presence immediately and publish offline after debounce', async () => {
  human.frames.length = 0;
  const ws = await connect(), uid = Number(bot.id.slice(2));
  await human.waitFor(f => f.type === 'chat_presence' && f.presence === 'online');
  const g = [...presence.connections.get(uid)][0];
  g.ws.emit('error', new Error('simulated transport error'));
  assert.equal(presence.status(uid), 'offline');
  await human.waitFor(f => f.type === 'chat_presence' && f.presence === 'offline');
  assert.ok(!other.frames.some(f => f.type === 'chat_presence'));
  ws.terminate();
});

test('stale READY socket is swept without waiting for close; removed members receive no presence', async () => {
  const ws = await connect(), uid = Number(bot.id.slice(2));
  human.frames.length = 0;
  await human.waitFor(f => f.type === 'chat_presence' && f.presence === 'online');
  // Unsubscribe the viewer before the debounced offline event.
  const c = db.get('SELECT * FROM communities WHERE sid = ?', sid);
  C.removeMember(c, auth.userByPrincipal(owner.user.id).id, 'left');
  human.frames.length = 0;
  presence.sweep(Date.now() + HEARTBEAT_TIMEOUT + 1);
  assert.equal(presence.status(uid), 'offline');
  assert.equal((await owner.a.get(`/api/v1/servers/${sid}/members`)).status, 403);
  await sleep(2200);
  assert.ok(!human.frames.some(f => f.type === 'chat_presence'));
  assert.ok(!other.frames.some(f => f.type === 'chat_presence'));
  ws.terminate();
});
