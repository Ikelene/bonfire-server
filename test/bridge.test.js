'use strict';
// Discord / Fluxer bridge against a local fake of Discord's REST API, CDN and gateway (no real Discord):
// token check + masking, gateway identify, auto-linking by name, inbound posts (avatar + attachment re-hosted, mentions
// neutralised), outbound webhook posts with name + avatar, edits / deletes both ways, no echo loop, webhook re-creation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const { WebSocketServer } = require('ws');
const { startServer } = require('../src/index');
const { tmpDir, api, wsClient } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_OWNER;
delete process.env.BONFIRE_DISCORD_TOKEN;
const dir = tmpDir();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const TOKEN = 'good.discord.token-WXYZ', FTOKEN = 'good.fluxer.token-QRST';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await sleep(25); } }

// ---- the fake platform ----
const calls = [];        // every REST call: { method, path, auth, body }
const idents = [];       // identify payloads seen by the fake gateway
const resumes = [];      // resume payloads
const gw = new Set();    // open gateway sockets
let fail404 = 0, hookN = 0, msgN = 0, fake, fbase;
function fakeServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const p = u.pathname, auth = req.headers.authorization || null;
      const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      let parsed = null; try { parsed = body ? JSON.parse(body) : null; } catch { /* not json */ }
      calls.push({ method: req.method, path: p + u.search, auth, body: parsed });
      if (p.startsWith('/avatars/') || p.startsWith('/attachments/')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
      if (p === '/.well-known/fluxer') return json(200, { endpoints: { api: fbase + '/fluxer', gateway: fbase.replace('http', 'ws') + '/gw' } });
      const pth = p.replace(/^\/fluxer/, '');
      const okAuth = auth === `Bot ${TOKEN}` || auth === `Bot ${FTOKEN}`;
      if (pth === '/users/@me') return okAuth ? json(200, { id: '900', username: 'TestBot' }) : json(401, { message: '401: Unauthorized' });
      if (pth.startsWith('/webhooks/')) { // webhook token in the path, no auth
        const [, , id, tok, , mid] = pth.split('/');
        if (tok !== `tok${id}`) return json(401, { message: 'Invalid Webhook Token' });
        if (req.method === 'POST') { if (fail404 > 0) { fail404--; return json(404, { message: 'Unknown Webhook' }); } return json(200, { id: `8${++msgN}`, channel_id: '222', webhook_id: id }); }
        if (req.method === 'PATCH' || req.method === 'DELETE') return mid ? json(200, { id: mid }) : (res.writeHead(204), res.end());
      }
      if (!okAuth) return json(401, { message: '401: Unauthorized' });
      if (pth === '/gateway/bot') return json(200, { url: fbase.replace('http', 'ws') + '/gw' });
      if (pth === '/users/@me/guilds') return json(200, [{ id: '111', name: 'Fake Guild', icon: null }]);
      if (pth === '/guilds/111') return json(200, { id: '111', name: 'Fake Guild' });
      if (pth === '/guilds/111/channels') return json(200, [{ id: '400', type: 4, name: 'Text', position: 0 }, { id: '222', type: 0, name: 'General', position: 1, parent_id: '400' }, { id: '223', type: 0, name: 'random', position: 2 }, { id: '224', type: 2, name: 'Voice', position: 3 }]);
      if (pth === '/guilds/111/roles') return json(200, [{ id: '111', name: '@everyone', permissions: '0' }, { id: '5', name: 'Mods', permissions: '0' }]);
      if (pth === '/guilds/111/emojis') return json(200, []);
      if (pth === '/guilds/999') return json(404, { message: 'Unknown Guild' });
      const wh = /^\/channels\/(\d+)\/webhooks$/.exec(pth);
      if (wh && req.method === 'POST') { const id = String(7000 + ++hookN); return json(200, { id, token: `tok${id}`, name: parsed?.name }); }
      if (/^\/channels\/\d+\/messages\/\d+$/.test(pth) && req.method === 'DELETE') { res.writeHead(204); return res.end(); }
      json(404, { message: 'Unknown' });
    });
  });
  const wss = new WebSocketServer({ server, path: '/gw' });
  wss.on('connection', ws => {
    gw.add(ws);
    ws.on('close', () => gw.delete(ws));
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
    ws.on('message', raw => {
      const m = JSON.parse(String(raw));
      if (m.op === 2) {
        idents.push(m.d);
        if (m.d.token !== TOKEN && m.d.token !== FTOKEN) return ws.close(4004, 'Authentication failed');
        ws.bfToken = m.d.token;
        ws.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 's1', user: { id: '900', username: 'TestBot' } } }));
      }
      if (m.op === 6) { resumes.push(m.d); ws.bfToken = m.d.token; ws.send(JSON.stringify({ op: 0, t: 'RESUMED', s: m.d.seq + 1, d: {} })); }
      if (m.op === 1) ws.send(JSON.stringify({ op: 11 }));
    });
  });
  return server;
}
let seq = 1;
const dispatch = (t, d, token = TOKEN) => { for (const ws of gw) if (ws.bfToken === token) ws.send(JSON.stringify({ op: 0, t, s: ++seq, d })); };

let inst, base, PL, B;
const clients = [];
test.before(async () => {
  fake = fakeServer();
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  fbase = `http://127.0.0.1:${fake.address().port}`;
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} });
  base = inst.url;
  PL = require('../src/bridge/platform');
  B = require('../src/bridge/bridge');
  const media = /^http:\/\/127\.0\.0\.1:\d+\//;
  PL._test.set('discord', { api: fbase, cdn: fbase, media });
  PL._test.set('fluxer', { api: null, discovery: fbase + '/.well-known/fluxer', cdn: fbase, media });
});
test.after(async () => { clients.forEach(c => c.close()); await inst.close(); for (const ws of gw) ws.terminate(); fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); const a = api(base, r.body.session), post = a.post; a.post = (p, b) => { if (/\/messages$/.test(p)) require('../src/messages')._sendLimit.reset(); return post(p, b); }; return { ...r.body, a }; };
let alice, bob, sid, general, wa;
const S = p => `/api/v1/servers/${sid}${p}`;
const execs = () => calls.filter(c => c.method === 'POST' && /^\/webhooks\/\d+\/tok\d+\?wait=true$/.test(c.path));

test('setup', async () => {
  alice = await reg('alice'); bob = await reg('bob');
  await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  const d = (await alice.a.post('/api/v1/servers', { name: 'Bridged', join_policy: 'open' })).body;
  sid = d.server.sid; general = d.channels.find(c => c.type === 'text').cid;
  await bob.a.post(S('/join'));
  await alice.a.patch('/api/v1/instance/settings', { icon_url: 'https://cdn.example/icon.png' });
  wa = await wsClient(base).login(alice.session); clients.push(wa);
});

test('bot tokens: checked on save, write-only, masked; the gateway identifies with the message intents', async () => {
  const s0 = (await alice.a.get('/api/v1/bridge/settings')).body.bridges;
  assert.equal(s0.discord.configured, false);
  assert.equal(s0.discord.token, null);
  assert.equal((await bob.a.get('/api/v1/bridge/settings')).status, 403); // instance admins only
  const bad = await alice.a.patch('/api/v1/bridge/settings', { discord: { token: 'nope' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_token');
  const ok = await alice.a.patch('/api/v1/bridge/settings', { discord: { token: TOKEN } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.bridges.discord.configured, true);
  assert.equal(ok.body.bridges.discord.token, '********WXYZ');
  const got = await alice.a.get('/api/v1/bridge/settings');
  assert.ok(!JSON.stringify(got.body).includes(TOKEN)); // never sent back
  assert.equal(got.body.bridges.discord.bot.username, 'TestBot');
  assert.ok(!fs.readFileSync(`${dir}/config.json`, 'utf8').includes(TOKEN)); // not in config.json either (database only)
  const id = await until(() => idents.find(x => x.token === TOKEN));
  assert.equal(id.intents, 1 | 512 | 32768); // GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT
  await until(async () => (await alice.a.get('/api/v1/bridge/settings')).body.bridges.discord.state === 'ready');
  // an empty token keeps the stored one
  assert.equal((await alice.a.patch('/api/v1/bridge/settings', { discord: { token: '' } })).body.bridges.discord.token, '********WXYZ');
  assert.equal((await api(base).get('/.well-known/bonfire')).body.features.bridges.discord, true);
});

test('gateway: op 7 (reconnect) resumes the session; op 1 is answered with a heartbeat', async () => {
  const beats = [];
  for (const ws of gw) { ws.on('message', raw => { const m = JSON.parse(String(raw)); if (m.op === 1) beats.push(m); }); ws.send(JSON.stringify({ op: 1, d: null })); }
  await until(() => beats.length);
  for (const ws of gw) ws.send(JSON.stringify({ op: 7, d: null }));
  const r = await until(() => resumes.find(x => x.token === TOKEN));
  assert.equal(r.session_id, 's1');
  assert.equal(typeof r.seq, 'number');
  assert.equal(idents.filter(x => x.token === TOKEN).length, 1); // resumed, not identified again
  await until(async () => (await alice.a.get('/api/v1/bridge/settings')).body.bridges.discord.state === 'ready');
});

test('platforms + guilds + linking auto-maps channels by name and makes the webhook', async () => {
  const plats = (await alice.a.get('/api/v1/bridge/platforms')).body.platforms;
  const d = plats.find(p => p.id === 'discord');
  assert.equal(d.ready, true);
  assert.equal(d.bot, 'TestBot');
  assert.match(d.invite, /client_id=900/);
  assert.equal(plats.find(p => p.id === 'fluxer').ready, false);
  assert.deepEqual((await alice.a.get('/api/v1/bridge/discord/guilds')).body.guilds, [{ id: '111', name: 'Fake Guild', icon: null }]);
  assert.equal((await bob.a.get('/api/v1/bridge/discord/guilds')).status, 403); // Manage server
  assert.equal((await alice.a.put(S('').replace('/servers/', '/bridge/servers/'), { platform: 'discord', guild_id: '999' })).body.error, 'bot_not_in_server');
  const st = await alice.a.put(`/api/v1/bridge/servers/${sid}`, { platform: 'discord', guild_id: '111' });
  assert.equal(st.status, 200, JSON.stringify(st.body));
  const b = st.body.bridges[0];
  assert.equal(b.guild_name, 'Fake Guild');
  assert.deepEqual(b.links, [{ cid: general, ext_channel_id: '222', ext_name: 'General', hook: true }]); // "general" == "General"
  assert.deepEqual(b.ext_channels.map(x => x.id), ['222', '223']); // text channels only
  assert.ok(calls.some(c => c.method === 'POST' && c.path === '/channels/222/webhooks' && c.body.name === 'Bonfire bridge'));
  assert.equal((await alice.a.put(`/api/v1/bridge/servers/${sid}`, { platform: 'discord', guild_id: '111' })).body.error, 'already_bridged');
  const ch = (await alice.a.get(S(''))).body.channels.find(c => c.cid === general);
  assert.deepEqual(ch.bridges, [{ platform: 'discord', name: 'General' }]);
  assert.deepEqual(ch.bridged, { platform: 'discord', name: 'General' });
});

let inboundId;
test('Discord -> here: posted as the person, picture + attachment re-hosted, nothing pings, not sent back', async () => {
  const before = execs().length;
  dispatch('MESSAGE_CREATE', {
    id: '5001', channel_id: '222', type: 0, author: { id: '42', username: 'zed', global_name: 'Zed', avatar: 'abc123' }, member: { nick: 'Zeddy' },
    content: 'hi <@42> @everyone and <@&5>', mentions: [{ id: '42', username: 'zed', member: { nick: 'Zeddy' } }],
    attachments: [{ id: '1', url: `${fbase}/attachments/1/pic.png`, filename: 'pic.png', size: PNG.length }],
  });
  const m = await wa.waitFor(f => f.type === 'chat_message' && f.message.channel === general && f.message.author?.bridge === 'discord');
  inboundId = m.message.id;
  assert.equal(m.message.author.username, 'Zeddy');
  assert.equal(m.message.author.webhook, true);
  assert.match(m.message.author.pfp, /\/uploads\/bridge\/avatars\/discord_42_abc123\.png$/);
  assert.equal(m.message.body, 'hi @​Zeddy @​everyone and @​Mods');
  assert.equal(m.message.mention_everyone, null);
  assert.equal(m.message.attachments.length, 1);
  assert.match(m.message.attachments[0].url, /\/uploads\/\d{4}\/\d{2}\/[0-9a-f]+\.png$/);
  assert.equal(m.message.attachments[0].type, 'image');
  const pic = await fetch(m.message.attachments[0].url.replace(/^https?:\/\/[^/]+/, base));
  assert.equal(pic.status, 200);
  await B.idle(); await sleep(50);
  assert.equal(execs().length, before); // a Discord message is never sent back to Discord
  // a message in a channel that isn't linked is ignored
  dispatch('MESSAGE_CREATE', { id: '5002', channel_id: '223', type: 0, author: { id: '43', username: 'x' }, content: 'elsewhere' });
  await sleep(100); await B.idle();
  assert.ok(!(await alice.a.get(`/api/v1/channels/${general}/messages`)).body.messages.some(x => x.body === 'elsewhere'));
});

let outId, outExt;
test('here -> Discord: the webhook posts with the name and picture; our own posts never come back', async () => {
  const r = await alice.a.post(`/api/v1/channels/${general}/messages`, { message: 'hello <@&r0000000000> discord' });
  outId = r.body.message.id;
  const call = await until(() => execs().find(c => c.body?.content?.includes('discord')));
  assert.equal(call.auth, null); // webhook execution uses the webhook token, not the bot token
  assert.equal(call.body.username, 'alice');
  assert.equal(call.body.avatar_url, 'https://cdn.example/icon.png'); // no profile picture -> the instance icon (absolute URL)
  assert.deepEqual(call.body.allowed_mentions, { parse: [] });
  await B.idle();
  outExt = require('../src/db').get('SELECT ext_message_id FROM bridge_msgs WHERE message_id = ? AND outbound = 1', Number(outId)).ext_message_id;
  // Discord delivers our webhook's message to the gateway too: it must not be posted here again
  const hookId = calls.find(c => c.path === '/channels/222/webhooks') && require('../src/db').get('SELECT hook_id FROM bridge_channels').hook_id;
  dispatch('MESSAGE_CREATE', { id: outExt, channel_id: '222', type: 0, webhook_id: hookId, author: { id: hookId, username: 'alice' }, content: 'hello @role discord' });
  dispatch('MESSAGE_CREATE', { id: '9999', channel_id: '222', type: 0, webhook_id: hookId, author: { id: hookId, username: 'alice' }, content: 'other hook post' });
  await sleep(150); await B.idle();
  const hist = (await alice.a.get(`/api/v1/channels/${general}/messages`)).body.messages;
  assert.equal(hist.filter(x => x.author?.bridge).length, 1); // only zed's
  // names Discord refuses are cleaned
  assert.equal(B.hookName('DiscordClyde fan'), 'fan');
  assert.equal(B.hookName('clyde'), 'Bonfire');
});

test('edits and deletes are mirrored both ways', async () => {
  // here -> there
  await alice.a.patch(`/api/v1/messages/${outId}`, { message: 'hello edited' });
  const pe = await until(() => calls.find(c => c.method === 'PATCH' && c.path.endsWith(`/messages/${outExt}`)));
  assert.equal(pe.body.content, 'hello edited');
  await alice.a.del(`/api/v1/messages/${outId}`);
  await until(() => calls.find(c => c.method === 'DELETE' && /^\/webhooks\/\d+\/tok\d+\/messages\//.test(c.path) && c.path.endsWith(`/messages/${outExt}`)));
  // there -> here
  dispatch('MESSAGE_UPDATE', { id: '5001', channel_id: '222', content: 'hi (edited)' });
  const up = await wa.waitFor(f => f.type === 'chat_message_update' && f.message.id === inboundId);
  assert.equal(up.message.body, 'hi (edited)');
  assert.ok(up.message.edited_at);
  dispatch('MESSAGE_UPDATE', { id: '5001', channel_id: '222', embeds: [] }); // no content = an embed update, ignored
  dispatch('MESSAGE_DELETE', { id: '5001', channel_id: '222' });
  await wa.waitFor(f => f.type === 'chat_message_delete' && f.id === inboundId);
  // a moderator deleting a Discord message here deletes it there with the bot (needs Manage messages over there)
  dispatch('MESSAGE_CREATE', { id: '5003', channel_id: '222', type: 0, author: { id: '44', username: 'yan' }, content: 'delete me' });
  const m3 = await wa.waitFor(f => f.type === 'chat_message' && f.message.body === 'delete me');
  await B.idle();
  await alice.a.del(`/api/v1/messages/${m3.message.id}`);
  const del = await until(() => calls.find(c => c.method === 'DELETE' && c.path === '/channels/222/messages/5003'));
  assert.equal(del.auth, `Bot ${TOKEN}`);
});

test('a webhook deleted over there is made again', async () => {
  const hooksBefore = calls.filter(c => c.path === '/channels/222/webhooks').length;
  fail404 = 1;
  await alice.a.post(`/api/v1/channels/${general}/messages`, { message: 'after the hook was deleted' });
  await until(() => execs().find(c => c.body?.content === 'after the hook was deleted' && !fail404) && calls.filter(c => c.path === '/channels/222/webhooks').length === hooksBefore + 1);
  await B.idle();
  const id = require('../src/db').get('SELECT ext_message_id FROM bridge_msgs WHERE platform = ? AND outbound = 1 ORDER BY created_at DESC LIMIT 1', 'discord');
  assert.ok(id);
});

test('channel settings: relink, pause, unlink (Manage server)', async () => {
  const p = `/api/v1/bridge/servers/${sid}`;
  assert.equal((await bob.a.get(p)).status, 403);
  let st = (await alice.a.put(`${p}/channels/${general}`, { platform: 'discord', ext_channel_id: '223' })).body;
  assert.equal(st.bridges[0].links[0].ext_channel_id, '223');
  assert.equal((await alice.a.put(`${p}/channels/${general}`, { platform: 'discord', ext_channel_id: '224' })).body.error, 'channel_not_found'); // voice over there
  st = (await alice.a.patch(p, { platform: 'discord', enabled: false })).body;
  assert.equal(st.bridges[0].enabled, false);
  const n = execs().length;
  await alice.a.post(`/api/v1/channels/${general}/messages`, { message: 'paused' });
  await sleep(100); await B.idle();
  assert.equal(execs().length, n);
  await alice.a.patch(p, { platform: 'discord', enabled: true });
  st = (await alice.a.del(p + '?platform=discord')).body;
  assert.deepEqual(st.bridges, []);
  assert.ok(calls.some(c => c.method === 'DELETE' && /^\/webhooks\/\d+\/tok\d+$/.test(c.path))); // its webhooks are removed over there
});

test('Fluxer: discovered endpoints, identify without intents', async () => {
  const r = await alice.a.patch('/api/v1/bridge/settings', { fluxer: { token: FTOKEN } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(calls.some(c => c.path === '/.well-known/fluxer'));
  assert.ok(calls.some(c => c.path === '/fluxer/users/@me'));
  const id = await until(() => idents.find(x => x.token === FTOKEN));
  assert.equal(id.intents, undefined);
  await alice.a.put(`/api/v1/bridge/servers/${sid}`, { platform: 'fluxer', guild_id: '111', automap: false });
  await alice.a.put(`/api/v1/bridge/servers/${sid}/channels/${general}`, { platform: 'fluxer', ext_channel_id: '222' });
  dispatch('MESSAGE_CREATE', { id: '6001', channel_id: '222', type: 0, author: { id: '50', username: 'flux' }, content: 'from fluxer' }, FTOKEN);
  const m = await wa.waitFor(f => f.type === 'chat_message' && f.message.author?.bridge === 'fluxer');
  assert.equal(m.message.body, 'from fluxer');
  // removing the token stops the client
  const off = (await alice.a.patch('/api/v1/bridge/settings', { fluxer: { token: null } })).body.bridges.fluxer;
  assert.equal(off.configured, false);
  assert.equal(off.state, 'off');
});

test('id map rows older than 60 days are pruned', () => {
  const db = require('../src/db');
  db.run('INSERT INTO bridge_msgs (message_id, platform, ext_message_id, ext_channel_id, outbound, created_at) VALUES (?, ?, ?, ?, 0, ?)', 999999, 'discord', '1', '222', Date.now() - B.RETENTION - 1000);
  B.init(); // also runs the prune once
  assert.equal(db.get('SELECT 1 AS x FROM bridge_msgs WHERE message_id = 999999'), undefined);
});
