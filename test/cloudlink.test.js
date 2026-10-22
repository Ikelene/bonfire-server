'use strict';
// CloudLink bridge: a logs channel in CloudLink mode joins a local CL4-style WebSocket server (BONFIRE_DEV=1 allows it):
// gmsg in and out, echo suppression, !online, SSRF refusal outside dev mode, the 3-per-community cap, export / import.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const { unzipSync, strFromU8 } = require('fflate');
const { startServer } = require('../src/index');
const { tmpDir, api, wsClient } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
process.env.BONFIRE_DEV = '1';
delete process.env.BONFIRE_OWNER;
const dir = tmpDir();
let inst, base, CL, cl, clUrl;
const clients = [];
const got = []; // packets the fake CloudLink server received
const peers = new Set();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await sleep(25); } }

test.before(async () => {
  // a tiny CloudLink 4 server: statuscode after handshake, replays its last gmsg first, echoes gmsg to everyone
  cl = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => cl.once('listening', r));
  clUrl = `ws://127.0.0.1:${cl.address().port}/`;
  cl.on('connection', ws => {
    peers.add(ws);
    ws.on('close', () => peers.delete(ws));
    ws.on('message', raw => {
      const p = JSON.parse(String(raw));
      got.push(p);
      if (p.cmd === 'handshake') {
        ws.send(JSON.stringify({ cmd: 'gmsg', val: 'Old: the replayed last message' })); // before ready: must be skipped
        ws.send(JSON.stringify({ cmd: 'statuscode', code: 'I:100 | OK' }));
        ws.send(JSON.stringify({ cmd: 'ulist', mode: 'set', val: ['zara', { username: 'amir' }] }));
      } else if (p.cmd === 'gmsg') for (const w of peers) w.send(JSON.stringify({ cmd: 'gmsg', val: p.val })); // CL echoes to the sender too
    });
  });
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} });
  base = inst.url;
  CL = require('../src/bridge/cloudlink');
});
test.after(async () => { clients.forEach(c => c.close()); await inst.close(); for (const w of peers) w.terminate(); cl.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); const a = api(base, r.body.session), post = a.post; a.post = (p, b) => { if (/\/messages$/.test(p)) require('../src/messages')._sendLimit.reset(); return post(p, b); }; return { ...r.body, a }; };
let alice, bob, sid, ch, wa;
const S = p => `/api/v1/servers/${sid}${p}`;
const say = val => { for (const w of peers) w.send(JSON.stringify({ cmd: 'gmsg', val })); };

test('a logs channel in CloudLink mode connects', async () => {
  alice = await reg('alice'); bob = await reg('bob');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  sid = (await alice.a.post('/api/v1/servers', { name: 'Cloud', join_policy: 'open' })).body.server.sid;
  await bob.a.post(S('/join'));
  wa = await wsClient(base).login(alice.session); clients.push(wa);
  const r = await alice.a.post(S('/channels'), { name: 'global', type: 'logs', config: { mode: 'cloudlink', url: clUrl, room: '', username: '' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  ch = r.body.channel;
  assert.deepEqual(ch.config, { mode: 'cloudlink', url: clUrl, room: '', username: '', official: false });
  const st = await until(async () => { const s = (await alice.a.get(`/api/v1/channels/${ch.cid}/cloudlink`)).body.status; return s?.state === 'connected' && s; });
  assert.equal(st.online, 2);
  assert.deepEqual(st.users.sort(), ['amir', 'zara']);
  assert.equal((await bob.a.get(`/api/v1/channels/${ch.cid}/cloudlink`)).status, 403); // Manage channels
  // a CloudLink channel is a chat: members with Send can post (plain logs channels need Manage messages)
  assert.equal((await bob.a.get(S(''))).body.channels.find(c => c.cid === ch.cid).can_post, true);
});

test('gmsg in: posted as the CloudLink name, tagged, nothing pings; the replay is skipped', async () => {
  say('[Discord] Bob: hi @everyone <@&r0123456789>');
  const m = await wa.waitFor(f => f.type === 'chat_message' && f.message.channel === ch.cid);
  assert.equal(m.message.author.bridge, 'cloudlink');
  assert.equal(m.message.author.username, 'Bob');
  assert.equal(m.message.author.bridge_from, 'Discord');
  assert.equal(m.message.body, 'hi @​everyone <​@​&r0123456789>');
  assert.equal(m.message.mention_everyone, null);
  const hist = (await alice.a.get(`/api/v1/channels/${ch.cid}/messages`)).body.messages;
  assert.ok(!hist.some(x => /replayed/.test(x.body)));
});

test('gmsg out: "Ember | name: text", and the echo is not posted again', async () => {
  const before = (await alice.a.get(`/api/v1/channels/${ch.cid}/messages`)).body.messages.length;
  assert.equal((await bob.a.post(`/api/v1/channels/${ch.cid}/messages`, { message: 'hello\ncloud' })).status, 200);
  const p = await until(() => got.find(x => x.cmd === 'gmsg' && x.val.startsWith('Ember | ')));
  assert.equal(p.val, 'Ember | bob: hello cloud');
  await sleep(300); // the server echoed it back by now
  const after = (await alice.a.get(`/api/v1/channels/${ch.cid}/messages`)).body.messages;
  assert.equal(after.length, before + 1); // only bob's own message
  // the same text said again later by someone else on CloudLink is not an echo
  say('Ember | bob: hello cloud');
  await until(async () => (await alice.a.get(`/api/v1/channels/${ch.cid}/messages`)).body.messages.length === before + 2);
});

test('!online answers from the user list and is not forwarded', async () => {
  const n = got.length;
  await alice.a.post(`/api/v1/channels/${ch.cid}/messages`, { message: '!online' });
  const m = await wa.waitFor(f => f.type === 'chat_message' && f.message.channel === ch.cid && f.message.author?.username === 'CloudLink');
  assert.equal(m.message.body, '**2** user(s) online: amir, zara');
  await sleep(100);
  assert.ok(!got.slice(n).some(x => x.cmd === 'gmsg'));
});

test('three CloudLink bridges per community at most', async () => {
  const mk = name => alice.a.post(S('/channels'), { name, type: 'logs', config: { mode: 'cloudlink', url: clUrl } });
  assert.equal((await mk('cl2')).status, 200);
  assert.equal((await mk('cl3')).status, 200);
  assert.equal((await mk('cl4')).body.error, 'too_many_cloudlink_bridges');
  assert.equal((await alice.a.post(S('/channels'), { name: 'plainlogs', type: 'logs', config: {} })).status, 200); // plain webhook logs are fine
});

test('SSRF: private, loopback, link-local and odd ports are refused outside dev mode', async () => {
  process.env.BONFIRE_DEV = '0';
  try {
    const set = url => alice.a.patch(`/api/v1/channels/${ch.cid}`, { config: { mode: 'cloudlink', url } });
    for (const url of ['ws://10.0.0.1/', 'ws://169.254.169.254/', 'ws://[::1]/', 'ws://127.0.0.1/', 'ws://localhost/', 'wss://[::ffff:10.0.0.1]/', 'ws://2130706433/', 'ws://printer.lan/']) {
      assert.equal((await set(url)).body.error, 'cl_private_address', url);
    }
    assert.equal((await set('ws://example.com:8080/')).body.error, 'cl_bad_port');
    assert.equal((await set('https://example.com/')).body.error, 'cl_bad_url');
    assert.equal((await set('wss://user:pw@example.com/')).body.error, 'cl_bad_url');
    assert.equal(CL._test.cleanUrl(''), CL.DEFAULT_URL); // empty = the official server
    // a public name that resolves to a private address is refused when connecting (DNS is checked every time)
    CL._test.setResolver((host, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.1.2.3', family: 4 }]));
    const e = await new Promise(r => CL._test.safeLookup('evil.example', {}, err => r(err)));
    assert.equal(e.code, 'EPRIVATE');
    CL._test.setResolver((host, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]));
    const ok = await new Promise(r => CL._test.safeLookup('fine.example', {}, (err, addr) => r(err || addr)));
    assert.equal(ok, '93.184.216.34');
    CL._test.resetResolver();
    // the dev-mode connection to 127.0.0.1 is refused once dev mode is off (re-checked when it reconnects)
    const cl2 = (await alice.a.get(S(''))).body.channels.find(c => c.name === 'cl2');
    await alice.a.post(`/api/v1/channels/${cl2.cid}/cloudlink/reconnect`); // drops the socket...
    await until(async () => (await alice.a.get(`/api/v1/channels/${cl2.cid}/cloudlink`)).body.status.state === 'waiting');
    await alice.a.post(`/api/v1/channels/${cl2.cid}/cloudlink/reconnect`); // ...and connects again right away
    const after = await until(async () => { const s = (await alice.a.get(`/api/v1/channels/${cl2.cid}/cloudlink`)).body.status; return s.state === 'waiting' && s; });
    assert.ok(['cl_bad_port', 'cl_private_address'].includes(after.error), after.error); // ws://127.0.0.1:<port>/ fails the port rule first
  } finally { process.env.BONFIRE_DEV = '1'; }
});

test('export / import keeps CloudLink and game channel settings', async () => {
  await alice.a.post(S('/channels'), { name: 'mc', type: 'game', config: { purpose: 'chat', address: 'mc.example.net', events: { death: false } } });
  const zip = (await alice.a.get(S('/export'))).body;
  const cj = JSON.parse(strFromU8(unzipSync(new Uint8Array(zip))['community.json']));
  assert.equal(cj.channels.find(c => c.name === 'cl2').config.mode, 'cloudlink');
  assert.equal(cj.channels.find(c => c.name === 'mc').type, 'game');
  assert.equal((await alice.a.del(S(''))).status, 200);
  const f = new FormData(); f.append('file', new Blob([zip]), 'x.zip');
  const r = await alice.a.raw('POST', '/api/v1/import', f);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  sid = r.body.sid;
  const chans = (await alice.a.get(S(''))).body.channels;
  const cls = chans.filter(c => c.type === 'logs' && c.config.mode === 'cloudlink');
  assert.equal(cls.length, 3);
  assert.equal(cls.find(c => c.name === 'global').config.url, clUrl);
  assert.equal(chans.find(c => c.name === 'cl2').config.url, clUrl);
  const mc = chans.find(c => c.name === 'mc');
  assert.equal(mc.type, 'game');
  assert.equal(mc.config.purpose, 'chat');
  assert.equal(mc.config.instance, null); // links don't travel
  assert.equal(mc.config.setup, false);
  assert.equal(mc.config.events.death, false);
  assert.equal(mc.config.address, 'mc.example.net');
});
