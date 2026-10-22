'use strict';
// Bonfire Link (Minecraft): the reference simulator (scripts/game-gateway-sim.js) connects to the instance's /game-gateway
// like the plugin does after `bonfire server <url>`, shows up in "Connected game servers", gets linked to a game channel,
// chats both ways; the console needs Manage server and lands in the audit log; abusive sockets are closed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');
const { startServer } = require('../src/index');
const { tmpDir, api, wsClient } = require('./helpers');
const { SimServer } = require('../scripts/game-gateway-sim');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_OWNER;
const dir = tmpDir();
let inst, base, GW, G;
const clients = [], sims = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await sleep(25); } }

test.before(async () => {
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} });
  base = inst.url;
  GW = require('../src/game/gateway');
  G = require('../src/game/game');
  GW._test.set({ listMinAge: 0, excessMs: 600 });
  require('../src/game/skins')._test.setLookup(async () => new Response(null, { status: 204 })); // never ask the real session server from a test
});
test.after(async () => { sims.forEach(s => s.close()); clients.forEach(c => c.close()); await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); assert.equal(r.status, 200); const a = api(base, r.body.session), post = a.post; a.post = (p, b) => { if (/\/messages$/.test(p)) require('../src/messages')._sendLimit.reset(); return post(p, b); }; return { ...r.body, a }; };
const sim = o => { const s = new SimServer({ url: base, heartbeatMs: 500, ...o }); sims.push(s); return s; };
let alice, bob, sid, wa, chat, consoleCh, s1;
const S = p => `/api/v1/servers/${sid}${p}`;
const steve = { uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', name: 'Notch', display: '[Admin] Notch' };

test('setup + discovery advertises minecraft', async () => {
  alice = await reg('alice'); bob = await reg('bob');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  sid = (await alice.a.post('/api/v1/servers', { name: 'Craft', join_policy: 'open' })).body.server.sid;
  await bob.a.post(S('/join'));
  wa = await wsClient(base).login(alice.session); clients.push(wa);
  assert.equal((await api(base).get('/.well-known/bonfire')).body.features.minecraft, true);
});

test('the simulator identifies (Ed25519) and shows up in Connected game servers', async () => {
  s1 = sim();
  const ready = await s1.connect();
  assert.equal(ready.iid, s1.iid);
  assert.equal(ready.pairing_tag, s1.tag);
  assert.equal(ready.linked, null);
  assert.equal(ready.icon_needed, true);
  assert.deepEqual(ready.relay, { chat: false, events: false });
  const list = await until(async () => { const r = await alice.a.get(`/api/v1/game/connected?sid=${sid}`); return r.body.instances?.[0]?.icon && r.body; });
  const me = list.instances.find(x => x.iid === s1.iid);
  assert.ok(me);
  assert.equal(me.pairing_tag, s1.tag);
  assert.equal(me.platform, 'paper');
  assert.equal(me.motd.map(x => x.text).join(''), 'Bonfire Link simulator');
  assert.match(me.icon, /\/uploads\/game-icons\/g[0-9a-f]{16}-[0-9a-f]{8}\.png$/); // the icon frame was stored
  assert.equal((await alice.a.get(`/api/v1/game/unclaimed?sid=${sid}&tag=${s1.tag.toLowerCase()}`)).body.instances[0].iid, s1.iid); // tag search, Velora's path
  assert.equal((await bob.a.get(`/api/v1/game/connected?sid=${sid}`)).status, 403); // Manage server only
});

test('an admin picks it for a game channel; members only see the channel once it is set up', async () => {
  chat = (await alice.a.post(S('/channels'), { name: 'mc-chat', type: 'game' })).body.channel;
  assert.equal(chat.type, 'game');
  assert.equal(chat.config.setup, false);
  assert.ok(!(await bob.a.get(S(''))).body.channels.some(c => c.cid === chat.cid)); // not set up = managers only
  assert.equal((await bob.a.post(`/api/v1/game/connected/${s1.iid}/link`, { sid, cid: chat.cid })).status, 403);
  const linkedFrame = s1.wait('linked');
  const r = await alice.a.post(`/api/v1/game/connected/${s1.iid}/link`, { sid, cid: chat.cid });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.instance.iid, s1.iid);
  assert.equal((await linkedFrame).server_name, 'Craft');
  await wa.waitFor(f => f.type === 'game_linked' && f.instance?.iid === s1.iid);
  assert.ok(!(await alice.a.get(`/api/v1/game/connected?sid=${sid}`)).body.instances.some(x => x.iid === s1.iid)); // no longer unclaimed
  assert.equal((await alice.a.post(`/api/v1/game/connected/${s1.iid}/link`, { sid })).body.error, 'already_linked');
  // the channel got the instance; picking the purpose finishes the setup and tells the game what to relay
  const ch1 = (await alice.a.get(S(''))).body.channels.find(c => c.cid === chat.cid);
  assert.equal(ch1.config.instance, s1.iid);
  const cfgFrame = s1.wait('config');
  const ed = await alice.a.patch(`/api/v1/channels/${chat.cid}`, { config: { ...ch1.config, purpose: 'chat' } });
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  assert.equal(ed.body.channel.config.setup, true);
  assert.equal(ed.body.channel.config.instance_name, 'Bonfire Link simulator');
  assert.deepEqual((await cfgFrame).relay, { chat: true, events: true });
  const seen = (await bob.a.get(S(''))).body.channels.find(c => c.cid === chat.cid);
  assert.equal(seen.can_post, true);
  const linked = (await alice.a.get(`/api/v1/game/servers/${sid}/instances`)).body.instances;
  assert.equal(linked[0].iid, s1.iid);
  assert.equal(linked[0].online, true);
  assert.equal(linked[0].linked_by, 'alice');
  assert.deepEqual(linked[0].channels, [{ cid: chat.cid, name: 'mc-chat', purpose: 'chat' }]);
});

test('chat both ways', async () => {
  // Minecraft -> Bonfire (nothing from the game pings anyone)
  s1.chat(steve, 'hello @everyone');
  const m = await wa.waitFor(f => f.type === 'chat_message' && f.message.channel === chat.cid && f.message.author?.bridge === 'minecraft');
  assert.equal(m.message.author.username, '[Admin] Notch');
  assert.equal(m.message.author.pfp, `https://mc-heads.net/avatar/${steve.uuid}/64`);
  assert.equal(m.message.body, 'hello @​everyone');
  s1.join({ ...steve, server: 'survival' });
  const j = await wa.waitFor(f => f.type === 'chat_message' && f.message.sys_kind === 'mc_join');
  assert.equal(j.message.body, 'joined the game');
  assert.equal(j.message.author.bridge_from, 'survival');
  // Bonfire -> Minecraft
  const got = s1.wait('chat');
  await alice.a.post(`/api/v1/channels/${chat.cid}/messages`, { message: '**hi** miners' });
  const f = await got;
  assert.equal(f.author.username, 'alice');
  assert.equal(f.channel, 'mc-chat');
  assert.deepEqual(f.segments, [{ text: 'hi', b: true }, { text: ' miners' }]);
  // status: the live card
  s1.players.set(steve.uuid, steve); s1.sendStatus();
  const st = await until(async () => { const r = (await alice.a.get(`/api/v1/game/channels/${chat.cid}/status`)).body; return r.status?.players?.online === 1 && r; });
  assert.equal(st.online, true);
  assert.equal(st.connected, true);
  assert.equal(st.instance.iid, s1.iid);
  assert.equal(st.status.players.list[0].name, 'Notch');
});

test('the skin the game sends becomes this instance\'s own head image (face + hat), anything else falls back to mc-heads', { skip: (() => { try { require('sharp'); return false; } catch { return true; } })() && 'sharp is not installed' }, async () => {
  const sharp = require('sharp');
  const SK = require('../src/game/skins');
  const hash = 'ab12cd34ef56ab12cd34ef56ab12cd34';
  // a 64x64 skin: face (8,8) red, the hat layer's first pixel (40,8) blue
  const face = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  const dot = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 1 } } }).png().toBuffer();
  const skin = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: face, left: 8, top: 8 }, { input: dot, left: 40, top: 8 }]).png().toBuffer();
  let hits = 0;
  SK._test.setDownload(async h => { hits++; return h === hash ? new Response(skin, { status: 200 }) : new Response('nope', { status: 404 }); });
  const send = async (p, text) => {
    s1.chat(p, text);
    return (await wa.waitFor(f => f.type === 'chat_message' && f.message.channel === chat.cid && f.message.body === text)).message.author.pfp;
  };
  const url = await send({ ...steve, skin: `https://textures.minecraft.net/texture/${hash}` }, 'skin one');
  assert.match(url, new RegExp(`/uploads/game-heads/${hash}\\.png$`));
  const img = await fetch(`${base}/uploads/game-heads/${hash}.png`);
  assert.equal(img.status, 200);
  const raw = await sharp(Buffer.from(await img.arrayBuffer())).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([raw.info.width, raw.info.height], [64, 64]);
  const px = (x, y) => [...raw.data.subarray((y * 64 + x) * raw.info.channels, (y * 64 + x) * raw.info.channels + 3)];
  assert.deepEqual(px(32, 32), [255, 0, 0]); // the face
  assert.deepEqual(px(2, 2), [0, 0, 255]);   // the hat layer on top
  // the same skin again comes from disk
  assert.equal(await send({ ...steve, skin: `https://textures.minecraft.net/texture/${hash}` }, 'skin two'), url);
  assert.equal(hits, 1);
  // a skin URL on another host is never fetched; a missing texture falls back to mc-heads
  assert.equal(await send({ ...steve, skin: 'https://evil.example/texture/' + hash }, 'skin three'), `https://mc-heads.net/avatar/${steve.uuid}/64`);
  assert.equal(await send({ ...steve, skin: 'https://textures.minecraft.net/texture/00000000deadbeef00000000' }, 'skin four'), `https://mc-heads.net/avatar/${steve.uuid}/64`);
  assert.equal(hits, 2);
  // no skin from the game (an older mod): Mojang's session server is asked by UUID, once, and its skin is rendered the same way
  let asked = 0;
  const prop = Buffer.from(JSON.stringify({ textures: { SKIN: { url: `http://textures.minecraft.net/texture/${hash}` } } })).toString('base64');
  SK._test.setLookup(async () => { asked++; return new Response(JSON.stringify({ id: 'x', name: 'Notch', properties: [{ name: 'textures', value: prop }] }), { status: 200 }); });
  assert.match(await send({ ...steve }, 'skin six'), new RegExp(`/uploads/game-heads/${hash}\\.png$`));
  assert.match(await send({ ...steve }, 'skin seven'), new RegExp(`/uploads/game-heads/${hash}\\.png$`));
  assert.equal(asked, 1);
  assert.equal(await send({ ...steve, bedrock: true, uuid: '00000000-0000-0000-0009-01f64f65c7c3', name: '.Steve' }, 'skin eight'), 'https://mc-heads.net/avatar/Steve/64'); // Floodgate: by name, never looked up
  assert.equal(asked, 1);
  SK._test.setLookup(async () => new Response(null, { status: 204 }));
  // a client-supplied _head is ignored
  assert.equal(await send({ ...steve, _head: 'https://evil.example/x.png' }, 'skin five'), `https://mc-heads.net/avatar/${steve.uuid}/64`);
  SK._test.setDownload(u => fetch(u));
});

test('console: Manage server only, every command lands in the audit log', async () => {
  consoleCh = (await alice.a.post(S('/channels'), { name: 'mc-console', type: 'game', config: { instance: s1.iid, purpose: 'console' } })).body.channel;
  assert.equal(consoleCh.config.setup, true);
  // bob: not even with Manage channels (console channels are Manage server only)
  const role = (await alice.a.post(S('/roles'), { name: 'mods', permissions: 2 })).body.role;
  await alice.a.put(S(`/members/${bob.user.id}/roles/${role.rid}`));
  assert.ok(!(await bob.a.get(S(''))).body.channels.some(c => c.cid === consoleCh.cid));
  assert.equal((await bob.a.post(`/api/v1/game/channels/${consoleCh.cid}/console`, { command: 'op bob' })).status, 404);
  assert.equal((await bob.a.patch(`/api/v1/channels/${chat.cid}`, { config: { purpose: 'console' } })).status, 403); // can't make one either
  // alice runs one
  const lines = wa.waitFor(f => f.type === 'game_console' && f.channel === consoleCh.cid && f.lines.some(l => l.command === 'say hi' && l.status === 'ok'));
  const r = await alice.a.post(`/api/v1/game/channels/${consoleCh.cid}/console`, { command: '/say hi' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, output: ['(sim) ran: say hi'], truncated: false });
  await lines;
  // a command typed in the server console + a log line
  s1.localCommand('whitelist add Notch');
  s1.log_(['Done (1.2s)!']);
  await until(async () => (await alice.a.get(`/api/v1/game/channels/${consoleCh.cid}/console`)).body.lines?.some(l => l.msg === 'Done (1.2s)!'));
  const audit = await until(async () => { const a = (await alice.a.get(`/api/v1/game/servers/${sid}/audit`)).body; return a.entries?.some(e => e.status === 'local') && a; });
  const cmd = audit.entries.find(e => e.command === 'say hi');
  assert.equal(cmd.status, 'ok');
  assert.equal(cmd.user.username, 'alice');
  assert.equal(cmd.output_preview, '(sim) ran: say hi');
  assert.ok(audit.entries.some(e => e.command === '[CONSOLE] whitelist add Notch' && e.status === 'local' && e.user === null));
  assert.ok(audit.entries.some(e => e.kind === 'link' && e.instance === s1.iid));
  assert.equal((await bob.a.get(`/api/v1/game/servers/${sid}/audit`)).status, 403);
});

test('claim codes still work, and unlinking tells the game', async () => {
  const s2 = sim({ listing: 'private' });
  await s2.connect();
  assert.ok(!(await alice.a.get(`/api/v1/game/connected?sid=${sid}`)).body.instances.some(x => x.iid === s2.iid)); // private: only with its tag
  assert.equal((await alice.a.get(`/api/v1/game/connected?sid=${sid}&tag=${s2.tag}`)).body.instances[0].iid, s2.iid);
  const claim = (await alice.a.post('/api/v1/game/claims', { sid })).body;
  assert.match(claim.command, /^bonfire link [0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal((await s2.link('NOPE-NOPE')).error, 'invalid_code');
  const res = await s2.link(claim.code.toLowerCase());
  assert.deepEqual(res.ok, true);
  assert.equal((await alice.a.get(`/api/v1/game/claims/${claim.code}`)).body.state, 'linked');
  const gone = s2.wait('unlinked');
  assert.equal((await alice.a.del(`/api/v1/game/servers/${sid}/instances/${s2.iid}`)).status, 200);
  assert.equal((await gone).by, 'bonfire');
  await wa.waitFor(f => f.type === 'game_unlinked' && f.instance === s2.iid);
  s2.close();
});

test('bad signatures are refused (4003)', async () => {
  const ws = new WebSocket(base.replace('http', 'ws') + '/game-gateway?v=1');
  const closed = new Promise(r => ws.on('close', code => r(code)));
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.op !== 'hello') return;
    const k = crypto.generateKeyPairSync('ed25519');
    const spki = k.publicKey.export({ format: 'der', type: 'spki' });
    ws.send(JSON.stringify({ op: 'identify', d: { v: 1, key: spki.toString('base64'), sig: crypto.sign(null, Buffer.from('bonfire-gw-v1|wrong|g0'), k.privateKey).toString('base64') } }));
  });
  assert.equal(await closed, 4003);
});

test('rate limits: a frame flood is closed (4005), new identities per address are capped (4008)', async () => {
  const s3 = sim();
  await s3.connect();
  const flood = setInterval(() => { for (let i = 0; i < 40; i++) if (!s3.send('heartbeat', { seq: i })) break; }, 20);
  await until(() => s3.closed, 5000).finally(() => clearInterval(flood));
  assert.equal(s3.closed.code, 4005);
  // three identities exist from this address now (s1, s2, s3)
  GW._test.set({ newPerIpDay: 3 });
  const s4 = sim();
  await assert.rejects(s4.connect(), e => e.code === 4008);
  GW._test.set({ newPerIpDay: 5 });
  // known identities still get in
  const again = sim({ seed: undefined });
  again.key = s3.key; again.iid = s3.iid; again.tag = s3.tag;
  GW._test.set({ newPerIpDay: 0 });
  assert.equal((await again.connect()).iid, s3.iid);
  GW._test.set({ newPerIpDay: 5 });
  again.close();
});

test('retention: unlinked identities not seen for 30 days are purged; linked ones stay', async () => {
  const db = require('../src/db');
  const old = Date.now() - 31 * 24 * 3600e3;
  const s5 = sim(); await s5.connect(); s5.close();
  await until(() => !GW.isConnected(s5.iid));
  db.run('UPDATE game_instances SET last_seen = ? WHERE iid IN (?, ?)', old, s5.iid, s1.iid);
  const r = G.purge();
  assert.ok(r.instances >= 1);
  assert.equal(G.instanceRow(s5.iid), null);
  assert.ok(G.instanceRow(s1.iid)); // linked
});

test('toSegments + import config (unit)', () => {
  const snap = { roles: [{ rid: 'r0123456789', name: 'mods', color: '#ff0000' }] };
  assert.deepEqual(G.toSegments({ body: 'a <@&r0123456789> `x` https://e.x' }, snap), [{ text: 'a ' }, { text: '@mods', color: '#ff0000' }, { text: ' ' }, { text: 'x', code: true }, { text: ' ' }, { text: 'https://e.x', link: 'https://e.x', u: true }]);
  const ic = G.importConfig({ game: 'minecraft', instance: 'g0123456789abcdef', purpose: 'chat', events: { death: false }, address: 'mc.example.net' });
  assert.equal(ic.instance, null);
  assert.equal(ic.purpose, 'chat');
  assert.equal(ic.events.death, false);
  assert.equal(ic.address, 'mc.example.net');
});
