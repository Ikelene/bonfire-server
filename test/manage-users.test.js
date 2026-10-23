'use strict';
// Manage users on an instance: last login in the member list and the page each message was sent from, for holders only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer } = require('../src/index');
const { tmpDir, api, wsClient } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_OWNER;
const dir = tmpDir();
let inst, base, alice, bob, carol, sid, general, wsA, wsB, wsC;
const clients = [];
const S = p => `/api/v1/servers/${sid}${p}`;
const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); assert.equal(r.status, 200); return { ...r.body, a: api(base, r.body.session) }; };

test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url; });
test.after(async () => { clients.forEach(c => c.close()); await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('setup: alice owns, bob gets a Manage users role, carol is plain', async () => {
  alice = await reg('alice'); bob = await reg('bob'); carol = await reg('carol');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  const d = (await alice.a.post('/api/v1/servers', { name: 'Camp', join_policy: 'open' })).body;
  sid = d.server.sid; general = d.channels.find(c => c.type === 'text').cid;
  await bob.a.post(S('/join')); await carol.a.post(S('/join'));
  const role = (await alice.a.post(S('/roles'), { name: 'Watchers', permissions: 2048 })).body.role;
  assert.equal(role.permissions, 2048);
  assert.equal((await alice.a.put(S(`/members/${bob.user.id}/roles/${role.rid}`))).status, 200);
  wsC = await wsClient(base).login(carol.session); clients.push(wsC);
});

test('the member list shows last login to Manage users only', async () => {
  const mine = (await bob.a.get(S('/members'))).body.members.find(m => m.username === 'carol');
  assert.ok(mine.last_login > 0);
  const theirs = (await carol.a.get(S('/members'))).body.members.find(m => m.username === 'alice');
  assert.equal(theirs.last_login, undefined);
  assert.equal((await alice.a.get(S('/members'))).body.members.find(m => m.username === 'bob').last_login, null); // never connected
});

test('messages carry the page they came from only for Manage users', async () => {
  wsB = await wsClient(base).login(bob.session); clients.push(wsB);
  const r = await carol.a.raw('POST', `/api/v1/channels/${general}/messages`, { message: 'hello' }, { Origin: 'https://velora.example' });
  assert.equal(r.status, 200);
  const live = await wsB.waitFor(f => f.type === 'chat_message' && f.message.id === r.body.message.id);
  assert.deepEqual(live.message.via, { url: 'https://velora.example' });
  const plain = await wsC.waitFor(f => f.type === 'chat_message' && f.message.id === r.body.message.id);
  assert.equal(plain.message.via, undefined);
  assert.equal(plain.__via, undefined);
  const h = id => m => m.id === id;
  assert.deepEqual((await bob.a.get(`/api/v1/channels/${general}/messages`)).body.messages.find(h(r.body.message.id)).via, { url: 'https://velora.example' });
  assert.equal((await carol.a.get(`/api/v1/channels/${general}/messages`)).body.messages.find(h(r.body.message.id)).via, undefined);
  assert.equal(r.body.message.via, undefined);
});

test('IP addresses are never stored as a page', async () => {
  const r = await carol.a.raw('POST', `/api/v1/channels/${general}/messages`, { message: 'from lan' }, { Origin: 'http://192.168.1.5:5173' });
  const m = (await alice.a.get(`/api/v1/channels/${general}/messages`)).body.messages.find(x => x.id === r.body.message.id);
  assert.equal(m.via, undefined);
});
