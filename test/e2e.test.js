'use strict';
// Boots a real server (local accounts mode, random port, temp DATA_DIR) and drives it over HTTP + WebSocket.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { unzipSync, strFromU8 } = require('fflate');
const { startServer } = require('../src/index');
const { tmpDir, api, wsClient } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_OWNER;
const dir = tmpDir();
let inst, base, restarts = 0;
const clients = [];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => { restarts++; } }); base = inst.url; });
test.after(async () => { clients.forEach(c => c.close()); await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function register(name) {
  const r = await api(base).post('/api/v1/auth/register', { username: name, password: 'correct horse battery' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...r.body, a: api(base, r.body.session) };
}

let alice, bob, carol, sid, generalCid, voiceCid;

test('discovery, CORS and preflight', async () => {
  const r = await api(base).get('/.well-known/bonfire');
  assert.equal(r.status, 200);
  assert.equal(r.body.software, 'bonfire-server');
  assert.equal(r.body.protocol, 1);
  assert.equal(r.body.accounts_mode, 'local');
  assert.equal(r.body.claimed, false);
  assert.equal(r.body.registration, 'open');
  assert.equal(r.body.velora, null);
  assert.equal(typeof r.body.features.youtube, 'boolean'); // true only when yt-dlp is installed
  assert.deepEqual({ ...r.body.features, youtube: undefined }, { signing: false, voice: false, uploads: true, youtube: undefined, minecraft: true, bridges: { discord: false, fluxer: false, cloudlink: true } });
  assert.equal(r.body.community, null); // not set up yet
  assert.equal('public_communities' in r.body, false);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const pre = await fetch(base + '/api/v1/servers', { method: 'OPTIONS', headers: { Origin: 'https://velora.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,x-device-fingerprint' } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /X-Device-Fingerprint/);
  const nf = await api(base).get('/nope');
  assert.equal(nf.status, 404);
  assert.equal(nf.headers.get('access-control-allow-origin'), '*');
  const unauth = await api(base).get('/api/v1/servers');
  assert.equal(unauth.status, 401);
  assert.equal(unauth.body.error, 'invalid_session');
});

test('local register / login / me, then claim with the setup code', async () => {
  alice = await register('alice');
  assert.equal(alice.user.id.startsWith('l:'), true);
  assert.equal(alice.user.kind, 'local');
  assert.equal((await api(base).post('/api/v1/auth/register', { username: 'alice', password: 'whatever123' })).body.error, 'username_taken');
  assert.equal((await api(base).post('/api/v1/auth/register', { username: 'x', password: 'whatever123' })).body.error, 'invalid_username');
  assert.equal((await api(base).post('/api/v1/auth/login', { username: 'alice', password: 'wrong password' })).status, 401);
  const login = await api(base).post('/api/v1/auth/login', { username: 'ALICE', password: 'correct horse battery' });
  assert.equal(login.status, 200);
  const me = await api(base, login.body.session).get('/api/v1/me');
  assert.equal(me.body.user.username, 'alice');
  assert.equal(me.body.instance_admin, false);

  const code = inst.setup.current();
  assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.ok(fs.existsSync(path.join(dir, 'setup-code.txt')));
  assert.equal((await alice.a.post('/api/v1/instance/claim', { code: 'AAAA-AAAA' })).status, 403);
  const claim = await alice.a.post('/api/v1/instance/claim', { code: code.toLowerCase() });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  assert.ok(!fs.existsSync(path.join(dir, 'setup-code.txt')));
  assert.equal((await alice.a.post('/api/v1/instance/claim', { code })).status, 409);
  const me2 = await alice.a.get('/api/v1/me');
  assert.equal(me2.body.instance_owner, true);
  assert.equal(me2.body.instance_admin, true);
  assert.equal((await api(base).get('/.well-known/bonfire')).body.claimed, true);

  bob = await register('bob');
  carol = await register('carol');
  assert.equal((await bob.a.get('/api/v1/instance/settings')).status, 403);
});

test('instance settings, admins and restart', async () => {
  const s = await alice.a.patch('/api/v1/instance/settings', { name: 'Test Camp', registration: 'open', voice: { cf_app_id: 'app', cf_app_secret: 'shh' } });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.name, 'Test Camp');
  assert.equal(s.body.voice.has_app_secret, true);
  assert.equal(s.body.voice.cf_app_secret, undefined);
  assert.equal(s.body.voice.has_turn_token, false);
  assert.equal((await alice.a.patch('/api/v1/instance/settings', { max_upload_mb: 9999 })).body.error, 'invalid_max_upload_mb');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(onDisk.name, 'Test Camp');
  assert.equal(onDisk.voice.cf_app_secret, 'shh');
  assert.equal((await api(base).get('/.well-known/bonfire')).body.name, 'Test Camp');
  // owner-only admin management
  assert.equal((await bob.a.put('/api/v1/instance/admins/' + encodeURIComponent(carol.user.id))).status, 403);
  assert.equal((await alice.a.put('/api/v1/instance/admins/' + encodeURIComponent(carol.user.id))).status, 200);
  const admins = await alice.a.get('/api/v1/instance/admins');
  assert.deepEqual(admins.body.admins.map(u => u.username).sort(), ['alice', 'carol']);
  assert.equal(admins.body.owner.username, 'alice');
  assert.equal((await alice.a.del('/api/v1/instance/admins/' + encodeURIComponent(carol.user.id))).status, 200);
  assert.equal((await alice.a.del('/api/v1/instance/admins/' + encodeURIComponent(alice.user.id))).body.error, 'cannot_remove_owner');
  const rs = await alice.a.post('/api/v1/instance/restart');
  assert.equal(rs.status, 202);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(restarts, 1);
});

test('hand-editing config.json is picked up live and pushed as instance_update', async () => {
  const w = await wsClient(base).login(alice.session); clients.push(w);
  const file = path.join(dir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...cfg, description: 'edited by hand' }, null, 2));
  const f = await w.waitFor(x => x.type === 'instance_update' && x.settings.description === 'edited by hand', 5000);
  assert.equal(f.settings.name, 'Test Camp');
  assert.equal((await api(base).get('/.well-known/bonfire')).body.description, 'edited by hand');
});

test('per-user settings and identities', async () => {
  const p = await alice.a.patch('/api/v1/settings', { server_order: ['s0123456789'], compact: true, bogus_choice: undefined });
  assert.deepEqual(p.body.settings.server_order, ['s0123456789']);
  assert.equal(p.body.settings.compact, true);
  assert.equal((await alice.a.patch('/api/v1/settings', { server_order: ['nope'] })).body.settings.server_order[0], 's0123456789');
  const ids = await alice.a.get('/api/v1/identities?ids=' + encodeURIComponent(`${bob.user.id},l:9999`));
  assert.equal(ids.body.users[0].username, 'bob');
  assert.equal(ids.body.users[1].username, null);
});

test('create a community: defaults, detail shape', async () => {
  // only instance admins may create the community
  const denied = await bob.a.post('/api/v1/servers', { name: 'Nope' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'forbidden');
  assert.equal((await api(base).get('/.well-known/bonfire')).body.community, null);
  const r = await alice.a.post('/api/v1/servers', { name: 'Camp Fire', description: 'hello' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body;
  sid = d.server.sid;
  assert.match(sid, /^s[0-9a-f]{10}$/);
  assert.equal(d.server.role, 'owner');
  assert.equal(d.server.perms, 1023);
  assert.equal(d.server.join_policy, 'request');
  assert.equal(d.server.instance, base.replace('127.0.0.1', 'localhost'));
  assert.equal(d.server.allow_uploads, true);
  assert.deepEqual(d.categories, ['Text channels', 'Voice channels']);
  assert.equal(d.roles.length, 1);
  assert.equal(d.roles[0].name, '@everyone');
  assert.equal(d.roles[0].is_default, true);
  assert.equal(d.roles[0].permissions, 1 | 256);
  assert.equal(d.channels.length, 2);
  const general = d.channels.find(c => c.type === 'text');
  const voice = d.channels.find(c => c.type === 'voice');
  assert.equal(general.name, 'general');
  assert.equal(voice.name, 'General');
  generalCid = general.cid; voiceCid = voice.cid;
  assert.match(generalCid, /^c[0-9a-f]{10}$/);
  assert.equal(general.can_post, true);
  assert.equal(voice.can_post, false);
  assert.equal(general.unread, false);
  assert.equal(general.last_message_id, '0');
  assert.deepEqual(Object.keys(d.voice), [voiceCid]);
  const list = await alice.a.get('/api/v1/servers');
  assert.equal(list.body.servers[0].sid, sid);
  assert.equal(list.body.servers[0].unread, false);
  const mem = await alice.a.get(`/api/v1/servers/${sid}/members`);
  assert.equal(mem.body.members.length, 1);
  assert.equal(mem.body.members[0].role, 'owner');
  assert.equal(mem.body.members[0].id, alice.user.id);
});

test('one community per instance: second create -> 409, discovery shape', async () => {
  const again = await alice.a.post('/api/v1/servers', { name: 'Second' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'community_exists');
  assert.equal((await bob.a.post('/api/v1/servers', { name: 'Second' })).status, 403); // 403 wins for non-admins
  const d = (await api(base).get('/.well-known/bonfire')).body;
  assert.deepEqual(d.community, { sid, name: 'Camp Fire', icon_url: null, description: 'hello', member_count: 1, join_policy: 'request' });
  assert.equal(d.name, 'Camp Fire'); // the instance takes the community's name
  assert.equal(d.description, 'hello');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).name, 'Camp Fire');
  // legacy /discover returns the one community whether or not it is "listed"
  const disc = await bob.a.get('/api/v1/discover');
  assert.deepEqual(disc.body.servers.map(s => [s.sid, s.joined]), [[sid, false]]);
  assert.equal(d.community.sid, (await alice.a.get('/api/v1/servers')).body.servers[0].sid);
});

test('instance and community name/description/icon are the same values', async () => {
  const cfgFile = () => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  // instance -> community
  const s = await alice.a.patch('/api/v1/instance/settings', { name: 'Renamed Camp', description: 'via settings', icon_url: 'https://img.example/i.png' });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  let det = (await alice.a.get(`/api/v1/servers/${sid}`)).body.server;
  assert.deepEqual([det.name, det.description, det.icon], ['Renamed Camp', 'via settings', 'https://img.example/i.png']);
  assert.equal((await api(base).get('/.well-known/bonfire')).body.community.name, 'Renamed Camp');
  // community -> instance (PATCH + icon upload/delete)
  const p = await alice.a.patch(`/api/v1/servers/${sid}`, { name: 'Camp Fire', description: 'hello' });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual([cfgFile().name, cfgFile().description], ['Camp Fire', 'hello']);
  assert.equal((await alice.a.get('/api/v1/instance/settings')).body.name, 'Camp Fire');
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'icon.png');
  const up = await alice.a.raw('POST', `/api/v1/servers/${sid}/icon`, fd);
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.match(up.body.server.icon, /\/uploads\//);
  assert.equal(cfgFile().icon_url, up.body.server.icon);
  const disc = (await api(base).get('/.well-known/bonfire')).body;
  assert.equal(disc.icon_url, up.body.server.icon);
  assert.equal(disc.community.icon_url, up.body.server.icon);
  assert.equal((await alice.a.del(`/api/v1/servers/${sid}/icon`)).status, 200);
  assert.equal(cfgFile().icon_url, null);
  assert.equal((await api(base).get('/.well-known/bonfire')).body.community.icon_url, null);
  // a bad value is rejected on both sides without touching the other
  assert.equal((await alice.a.patch(`/api/v1/servers/${sid}`, { name: '  ' })).status, 400);
  assert.equal((await alice.a.patch('/api/v1/instance/settings', { name: '' })).status, 400);
  // removed settings are ignored in an old config.json
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ ...cfgFile(), community_creation: 'admins', auto_join: [sid] }, null, 2));
  await new Promise(r => setTimeout(r, 400));
  assert.equal('auto_join' in (await alice.a.get('/api/v1/instance/settings')).body, false);
  assert.equal('community_creation' in (await alice.a.get('/api/v1/instance/settings')).body, false);
});

test('join policy: request -> accept (with gateway events); invite codes always admit', async () => {
  const wa = await wsClient(base).login(alice.session); clients.push(wa);
  const wb = await wsClient(base).login(bob.session); clients.push(wb);
  const j1 = await bob.a.post(`/api/v1/servers/${sid}/join`, { message: 'let me in' });
  assert.deepEqual(j1.body, { pending: true });
  assert.deepEqual((await bob.a.post(`/api/v1/servers/${sid}/join`)).body, { pending: true });
  const req = await wa.waitFor(f => f.type === 'chat_join_request');
  assert.equal(req.sid, sid);
  assert.equal(req.request.user.username, 'bob');
  assert.equal(req.request.message, 'let me in');
  assert.equal((await bob.a.get(`/api/v1/servers/${sid}/requests`)).status, 403);
  const lst = await alice.a.get(`/api/v1/servers/${sid}/requests`);
  assert.equal(lst.body.requests.length, 1);
  assert.equal(lst.body.requests[0].user.id, bob.user.id);
  assert.equal((await alice.a.post(`/api/v1/servers/${sid}/requests/${encodeURIComponent(bob.user.id)}/accept`)).status, 200);
  const res = await wb.waitFor(f => f.type === 'chat_join_result');
  assert.deepEqual({ sid: res.sid, accepted: res.accepted }, { sid, accepted: true });
  const added = await wb.waitFor(f => f.type === 'chat_server_added');
  assert.equal(added.server.sid, sid);
  assert.equal(added.server.role, 'member');
  assert.equal((await bob.a.get(`/api/v1/servers/${sid}`)).status, 200);
  const upd = await wa.waitFor(f => f.type === 'chat_member_update' && f.change === 'joined');
  assert.equal(upd.username, 'bob');
  assert.equal(upd.member_count, 2);

  // invite code bypasses the request policy; deny works too
  const inv = await alice.a.post(`/api/v1/servers/${sid}/invites`, { max_uses: 1, expires_in: 3600 });
  assert.equal(inv.status, 200);
  assert.equal(inv.body.max_uses, 1);
  assert.equal(inv.body.uses, 0);
  const pub = await api(base).get('/api/v1/invite/' + inv.body.code);
  assert.equal(pub.body.server.sid, sid);
  assert.equal(pub.body.server.invite, undefined);
  const viaInvite = await carol.a.post('/api/v1/join/' + inv.body.code);
  assert.equal(viaInvite.body.server.sid, sid);
  assert.equal((await alice.a.get(`/api/v1/servers/${sid}/invites`)).body.invites[0].uses, 1);
  const dave = await register('dave');
  assert.equal((await dave.a.post('/api/v1/join/' + inv.body.code)).body.error, 'invalid_invite'); // used up
  assert.deepEqual((await dave.a.post(`/api/v1/servers/${sid}/join`)).body, { pending: true });
  const wd = await wsClient(base).login(dave.session); clients.push(wd);
  assert.equal((await alice.a.post(`/api/v1/servers/${sid}/requests/${encodeURIComponent(dave.user.id)}/deny`)).status, 200);
  assert.equal((await alice.a.get(`/api/v1/servers/${sid}/requests`)).body.requests.length, 0);
  assert.equal((await alice.a.del('/api/v1/invites/' + inv.body.code)).status, 200);
  // open policy
  assert.equal((await alice.a.patch(`/api/v1/servers/${sid}`, { join_policy: 'open' })).body.server.join_policy, 'open');
  assert.equal((await dave.a.post(`/api/v1/servers/${sid}/join`)).body.server.sid, sid);
  assert.equal((await dave.a.post(`/api/v1/servers/${sid}/leave`)).status, 200);
});

test('messages over the gateway, history, edit, react, pin, delete', async () => {
  const wa = await wsClient(base).login(alice.session); clients.push(wa);
  const wb = await wsClient(base).login(bob.session); clients.push(wb);
  wa.send({ type: 'chat_send', nonce: 'n1', channel: generalCid, message: 'hello @bob' });
  const ack = await wa.waitFor(f => f.type === 'chat_ack');
  assert.equal(ack.nonce, 'n1');
  const m = ack.message;
  assert.match(m.id, /^\d+$/);
  assert.equal(m.channel, generalCid);
  assert.equal(m.server, sid);
  assert.equal(m.author.id, alice.user.id);
  assert.equal(m.body, 'hello @bob');
  assert.equal(m.signature, null);
  assert.equal(m.verified, null);
  const got = await wb.waitFor(f => f.type === 'chat_message' && f.message.id === m.id);
  assert.equal(got.message.body, 'hello @bob');
  // bob's unread/mention counters
  const d = await bob.a.get(`/api/v1/servers/${sid}`);
  const g = d.body.channels.find(c => c.cid === generalCid);
  assert.equal(g.mentions, 1);
  assert.equal(g.unread, true);
  assert.equal((await bob.a.post(`/api/v1/channels/${generalCid}/read`, { id: m.id })).status, 200);
  assert.equal((await bob.a.get(`/api/v1/servers/${sid}`)).body.channels.find(c => c.cid === generalCid).mentions, 0);

  // errors
  wb.send({ type: 'chat_send', nonce: 'n2', channel: generalCid, message: '   ' });
  assert.equal((await wb.waitFor(f => f.type === 'chat_error' && f.nonce === 'n2')).error, 'empty_message');
  wb.send({ type: 'chat_send', nonce: 'n3', channel: voiceCid, message: 'in voice' });
  assert.equal((await wb.waitFor(f => f.type === 'chat_error' && f.nonce === 'n3')).error, 'no_send_permission');

  // REST post + reply + history
  const rest = await bob.a.post(`/api/v1/channels/${generalCid}/messages`, { message: 'hi alice', reply_to: m.id });
  assert.equal(rest.status, 200);
  assert.equal(rest.body.message.reply.id, m.id);
  assert.equal(rest.body.message.reply.author.username, 'alice');
  const h = await alice.a.get(`/api/v1/channels/${generalCid}/messages?limit=10`);
  assert.deepEqual(h.body.messages.map(x => x.body), ['hello @bob', 'hi alice']);
  assert.equal(h.body.has_more, false);
  assert.equal(h.body.channel.cid, generalCid);
  assert.equal((await alice.a.get(`/api/v1/channels/${generalCid}/messages?before=${rest.body.message.id}`)).body.messages.length, 1);
  assert.equal((await alice.a.get(`/api/v1/channels/${generalCid}/search?q=alice`)).body.messages.length, 1);

  // edit (own only), react, pin (needs Manage messages), delete
  assert.equal((await alice.a.patch(`/api/v1/messages/${rest.body.message.id}`, { message: 'x' })).status, 403);
  const ed = await bob.a.patch(`/api/v1/messages/${rest.body.message.id}`, { message: 'hi alice!' });
  assert.equal(ed.body.message.body, 'hi alice!');
  assert.ok(ed.body.message.edited_at);
  await wa.waitFor(f => f.type === 'chat_message_update' && f.message.id === rest.body.message.id);
  assert.equal((await bob.a.put(`/api/v1/messages/${m.id}/reactions/${encodeURIComponent('🔥')}`)).status, 200);
  const rx = await wa.waitFor(f => f.type === 'chat_reactions' && f.id === m.id);
  assert.equal(rx.reactions[0].count, 1);
  assert.equal(rx.username, 'bob');
  assert.equal(rx.user_id, bob.user.id);
  assert.equal((await bob.a.put(`/api/v1/messages/${m.id}/reactions/notanemoji`)).body.error, 'unknown_emoji');
  assert.equal((await bob.a.put(`/api/v1/messages/${m.id}/pin`)).status, 403);
  assert.equal((await alice.a.put(`/api/v1/messages/${m.id}/pin`)).status, 200);
  await wb.waitFor(f => f.type === 'chat_pins_update');
  const pins = await bob.a.get(`/api/v1/channels/${generalCid}/pins`);
  assert.equal(pins.body.messages.length, 1);
  assert.equal(pins.body.messages[0].reactions[0].emoji, '🔥');
  const sys = (await alice.a.get(`/api/v1/channels/${generalCid}/messages`)).body.messages.find(x => x.system);
  assert.equal(sys.sys_kind, 'pin');
  assert.equal(sys.subject.username, 'alice');
  assert.equal((await alice.a.del(`/api/v1/messages/${rest.body.message.id}`)).status, 200);
  const del = await wb.waitFor(f => f.type === 'chat_message_delete');
  assert.equal(del.id, rest.body.message.id);
  assert.equal((await bob.a.del(`/api/v1/messages/${m.id}`)).status, 403);
});

test('rate limit: 8 messages per 5 seconds', async () => {
  const eve = await register('eve');
  await eve.a.post('/api/v1/join/' + (await alice.a.post(`/api/v1/servers/${sid}/invites`)).body.code);
  let limited = 0;
  for (let i = 0; i < 10; i++) {
    const r = await eve.a.post(`/api/v1/channels/${generalCid}/messages`, { message: 'spam ' + i });
    if (r.status === 429) { limited++; assert.equal(r.body.error, 'rate_limited'); }
  }
  assert.equal(limited, 2);
});

test('roles, hierarchy, channel overwrites and visibility fan-out', async () => {
  const wb = await wsClient(base).login(bob.session); clients.push(wb);
  const role = await alice.a.post(`/api/v1/servers/${sid}/roles`, { name: 'Mods', permissions: 16 | 64 | 512 | 2048, color: '#ff0000' });
  assert.equal(role.status, 200);
  assert.equal(role.body.role.permissions, 16 | 64 | 512); // 2048 is not a permission bit
  const rid = role.body.role.rid;
  assert.equal((await bob.a.post(`/api/v1/servers/${sid}/roles`, { name: 'nope' })).status, 403);
  const everyone = (await alice.a.get(`/api/v1/servers/${sid}`)).body.roles.find(r => r.is_default);
  assert.equal((await alice.a.patch(`/api/v1/servers/${sid}/roles/${everyone.rid}`, { permissions: 1 | 256 | 128 })).body.role.permissions, 1 | 256 | 128);
  await alice.a.patch(`/api/v1/servers/${sid}/roles/${everyone.rid}`, { permissions: 1 | 256 });

  // a private channel only Mods can see
  const ch = await alice.a.post(`/api/v1/servers/${sid}/channels`, { name: 'Staff Room', topic: 'secret' });
  assert.equal(ch.body.channel.name, 'staff-room');
  const priv = ch.body.channel.cid;
  const set = await alice.a.put(`/api/v1/channels/${priv}/perms`, { overwrites: [{ rid: everyone.rid, allow: 0, deny: 1024 }, { rid, allow: 1024, deny: 0 }] });
  assert.equal(set.body.channel.private, true);
  assert.equal(set.body.channel.overwrites.length, 2);
  const seen = (await bob.a.get(`/api/v1/servers/${sid}`)).body.channels.map(c => c.cid);
  assert.equal(seen.includes(priv), false);
  assert.equal((await bob.a.get(`/api/v1/channels/${priv}/messages`)).status, 404);
  await alice.a.post(`/api/v1/channels/${priv}/messages`, { message: 'top secret' });
  await new Promise(r => setTimeout(r, 150));
  assert.equal(wb.frames.some(f => f.type === 'chat_message' && f.message.body === 'top secret'), false);
  // channel list updates are filtered per viewer
  const upd = wb.frames.filter(f => f.type === 'chat_channels_update').pop();
  assert.ok(upd);
  assert.equal(upd.channels.some(c => c.cid === priv), false);

  // give bob the role: perms refresh, channel visible, and he can now kick
  assert.equal((await alice.a.put(`/api/v1/servers/${sid}/members/${encodeURIComponent(bob.user.id)}/roles/${rid}`)).status, 200);
  await wb.waitFor(f => f.type === 'chat_perms_changed');
  assert.equal((await bob.a.get(`/api/v1/servers/${sid}`)).body.channels.some(c => c.cid === priv), true);
  assert.equal((await bob.a.get(`/api/v1/servers/${sid}/members`)).body.members.find(m => m.username === 'bob').role, 'admin');
  // hierarchy: bob (Administrator, but not owner) cannot kick the owner
  assert.equal((await bob.a.del(`/api/v1/servers/${sid}/members/${encodeURIComponent(alice.user.id)}`)).status, 403);
  assert.equal((await alice.a.del(`/api/v1/servers/${sid}/members/${encodeURIComponent(bob.user.id)}/roles/${rid}`)).status, 200);
  // kick + ban + unban carol
  assert.equal((await alice.a.del(`/api/v1/servers/${sid}/members/${encodeURIComponent(carol.user.id)}?ban=1`)).status, 200);
  assert.equal((await carol.a.get(`/api/v1/servers/${sid}`)).status, 403);
  assert.equal((await carol.a.post(`/api/v1/servers/${sid}/join`)).body.error, 'banned_from_server');
  assert.equal((await alice.a.get(`/api/v1/servers/${sid}/bans`)).body.bans.length, 1);
  assert.equal((await alice.a.del(`/api/v1/servers/${sid}/bans/${encodeURIComponent(carol.user.id)}`)).status, 200);
  assert.equal((await alice.a.del(`/api/v1/channels/${priv}`)).status, 200);
});

test('uploads, emojis, then export -> import round trip', async () => {
  // upload a PNG (magic-byte detected) and attach it
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'application/octet-stream' }), 'pixel.png');
  const up = await alice.a.raw('POST', `/api/v1/media/upload?sid=${sid}`, fd);
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.type, 'image');
  assert.equal(up.body.mime, 'image/png');
  assert.equal(up.body.width, 1);
  assert.match(up.body.sha256, /^[0-9a-f]{64}$/);
  assert.match(up.body.url, /\/uploads\/\d{4}\/\d{2}\/[0-9a-f]+\.png$/);
  const file = await fetch(up.body.url.replace('localhost', '127.0.0.1'));
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.match(file.headers.get('cache-control'), /immutable/);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
  const txt = new FormData();
  txt.append('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'x.html');
  const t = await alice.a.raw('POST', `/api/v1/media/upload?sid=${sid}`, txt);
  assert.equal(t.body.type, 'file');
  assert.equal((await fetch(t.body.url.replace('localhost', '127.0.0.1'))).headers.get('content-disposition'), 'attachment');
  assert.equal((await alice.a.raw('POST', '/api/v1/media/upload', fd)).body.error, 'sid_required');
  const withAtt = await alice.a.post(`/api/v1/channels/${generalCid}/messages`, { message: 'look', attachments: [up.body, { url: 'https://evil.example/x.png', type: 'image' }] });
  assert.equal(withAtt.body.message.attachments.length, 1);
  assert.equal(withAtt.body.message.attachments[0].sha256, up.body.sha256);

  // an emoji
  const efd = new FormData();
  efd.append('name', 'pixel');
  efd.append('file', new Blob([PNG]), 'pixel.png');
  const em = await alice.a.raw('POST', `/api/v1/servers/${sid}/emojis`, efd);
  assert.equal(em.status, 200, JSON.stringify(em.body));
  assert.match(em.body.emoji.eid, /^e[0-9a-f]{10}$/);
  assert.equal((await bob.a.get(`/api/v1/servers/${sid}/emojis`)).body.emojis.length, 1);
  await alice.a.put(`/api/v1/messages/${withAtt.body.message.id}/reactions/${encodeURIComponent(em.body.emoji.eid)}`);

  // counts before
  const before = await alice.a.get(`/api/v1/servers/${sid}`);
  const countMsgs = async (cid, a) => { let n = 0, before_ = ''; for (;;) { const r = await a.get(`/api/v1/channels/${cid}/messages?limit=100${before_}`); n += r.body.messages.length; if (!r.body.has_more) return n; before_ = '&before=' + r.body.messages[0].id; } };
  const chBefore = before.body.channels.length, roleBefore = before.body.roles.length;
  let msgsBefore = 0;
  for (const c of before.body.channels) if (c.type === 'text') msgsBefore += await countMsgs(c.cid, alice.a);
  assert.ok(msgsBefore >= 5, 'expected a handful of messages, got ' + msgsBefore);

  // only the owner may export
  assert.equal((await bob.a.raw('GET', `/api/v1/servers/${sid}/export`)).status, 403);
  const ex = await alice.a.raw('GET', `/api/v1/servers/${sid}/export`);
  assert.equal(ex.status, 200);
  assert.equal(ex.headers.get('content-type'), 'application/zip');
  const zip = unzipSync(new Uint8Array(ex.body));
  const manifest = JSON.parse(strFromU8(zip['manifest.json']));
  assert.equal(manifest.format, 'bonfire-export-v1');
  assert.equal(manifest.source_kind, 'instance');
  assert.equal(manifest.community, sid);
  assert.ok(zip['members.jsonl'] && zip['community.json']);
  assert.ok(Object.keys(zip).some(k => k.startsWith('messages/c')));
  assert.ok(Object.keys(zip).some(k => k.startsWith('files/') && k.endsWith('.png')));
  const cj = JSON.parse(strFromU8(zip['community.json']));
  assert.equal(cj.channels.length, chBefore);
  assert.equal(cj.roles.length, roleBefore);
  assert.equal(cj.emojis.length, 1);
  assert.equal(cj.emojis[0].file.startsWith('files/'), true);

  // import is only possible while the instance has no community
  const mk = () => { const f = new FormData(); f.append('file', new Blob([ex.body], { type: 'application/zip' }), 'export.zip'); return f; };
  assert.equal((await bob.a.raw('POST', '/api/v1/import', mk())).body.error, 'forbidden');
  const blocked = await alice.a.raw('POST', '/api/v1/import', mk());
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'community_exists');
  assert.equal((await alice.a.del(`/api/v1/servers/${sid}`)).status, 200);
  assert.equal((await api(base).get('/.well-known/bonfire')).body.community, null);

  // bad archives are rejected (and leave the instance not set up)
  const bad = new FormData();
  bad.append('file', new Blob([Buffer.from('not a zip')]), 'x.zip');
  assert.equal((await alice.a.raw('POST', '/api/v1/import', bad)).body.error, 'invalid_export');
  assert.equal((await api(base).get('/.well-known/bonfire')).body.community, null);

  // import it back as a brand new community owned by the instance owner
  const imp = await alice.a.raw('POST', '/api/v1/import', mk());
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.notEqual(imp.body.sid, sid);
  const after = await alice.a.get(`/api/v1/servers/${imp.body.sid}`);
  assert.equal(after.body.server.role, 'owner');
  assert.equal(after.body.channels.length, chBefore);
  assert.equal(after.body.roles.length, roleBefore);
  assert.deepEqual(after.body.categories, before.body.categories);
  assert.equal(after.body.server.name, before.body.server.name);
  let msgsAfter = 0;
  for (const c of after.body.channels) if (c.type === 'text') msgsAfter += await countMsgs(c.cid, alice.a);
  assert.equal(msgsAfter, msgsBefore);
  assert.notEqual(after.body.channels[0].cid, before.body.channels[0].cid);
  const gen = after.body.channels.find(c => c.name === 'general');
  const hist = (await alice.a.get(`/api/v1/channels/${gen.cid}/messages`)).body.messages;
  const att = hist.find(x => x.attachments.length);
  assert.ok(att, 'attachment preserved');
  assert.equal((await fetch(att.attachments[0].url.replace('localhost', '127.0.0.1'))).status, 200);
  assert.equal(att.reactions[0].emoji.startsWith('<:pixel:'), true);
  const replied = hist.find(x => x.reply);
  assert.ok(replied && replied.reply.id !== undefined, 'reply_to remapped');
  assert.equal(hist.find(x => x.pinned).pinned, true);
  assert.equal((await alice.a.get(`/api/v1/servers/${imp.body.sid}/emojis`)).body.emojis.length, 1);
  // bob (an existing local account of this very instance) is recreated as a member of the import
  assert.equal((await bob.a.get(`/api/v1/servers/${imp.body.sid}`)).status, 200);
  // instance admins may delete any community, other members may not
  assert.equal((await bob.a.del(`/api/v1/servers/${imp.body.sid}`)).status, 403);
  // the imported community is now the instance's community (name mirrored into discovery)
  const disc = (await api(base).get('/.well-known/bonfire')).body;
  assert.equal(disc.community.sid, imp.body.sid);
  assert.equal(disc.name, before.body.server.name);
  sid = imp.body.sid;
  generalCid = gen.cid;
  voiceCid = after.body.channels.find(c => c.type === 'voice').cid;
});

test('gateway: bad session closes with 4001; voice without keys is voice_unavailable', async () => {
  const bad = wsClient(base);
  await bad.open();
  bad.send({ type: 'auth', session: 'nope' });
  assert.equal((await bad.closed).code, 4001);
  const w = await wsClient(base).login(alice.session); clients.push(w);
  w.send({ type: 'ping' });
  await w.waitFor(f => f.type === 'pong');
  // keys are partially configured in a previous test, so voice stays unavailable
  w.send({ type: 'chat_rtc_join', nonce: 'v1', room: 'bf_' + voiceCid });
  assert.equal((await w.waitFor(f => f.type === 'chat_error' && f.nonce === 'v1')).error, 'voice_unavailable');
  w.send({ type: 'chat_rtc_join', nonce: 'v2', room: 'bf_c0000000000' });
  assert.equal((await w.waitFor(f => f.type === 'chat_error' && f.nonce === 'v2')).error, 'not_allowed');
});

test('delete returns the instance to "not set up"; it can be created again; admins create for the owner', async () => {
  assert.equal((await carol.a.del(`/api/v1/servers/${sid}`)).status, 403); // not a member, not an admin
  assert.equal((await alice.a.put('/api/v1/instance/admins/' + encodeURIComponent(carol.user.id))).status, 200);
  assert.equal((await carol.a.del(`/api/v1/servers/${sid}`)).status, 200); // instance admins may delete
  assert.equal((await alice.a.get(`/api/v1/servers/${sid}`)).status, 404);
  const gone = (await api(base).get('/.well-known/bonfire')).body;
  assert.equal(gone.community, null);
  assert.equal((await alice.a.get('/api/v1/servers')).body.servers.length, 0);
  assert.deepEqual((await alice.a.get('/api/v1/discover')).body.servers, []);
  // create again; an admin who is not the owner creates it: the owner still owns it, the creator is a member
  const r = await carol.a.post('/api/v1/servers', { name: 'Reborn', join_policy: 'open' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.server.role, 'member');
  const nsid = r.body.server.sid;
  assert.notEqual(nsid, sid);
  const mem = (await alice.a.get(`/api/v1/servers/${nsid}/members`)).body.members;
  assert.deepEqual(mem.map(m => [m.username, m.role]).sort(), [['alice', 'owner'], ['carol', 'member']]);
  assert.equal((await alice.a.get(`/api/v1/servers/${nsid}`)).body.server.role, 'owner');
  const d = (await api(base).get('/.well-known/bonfire')).body;
  assert.deepEqual(d.community, { sid: nsid, name: 'Reborn', icon_url: null, description: '', member_count: 2, join_policy: 'open' });
  assert.equal(d.name, 'Reborn');
  assert.equal((await alice.a.post('/api/v1/servers', { name: 'again' })).body.error, 'community_exists');
  // joining works by sid on an open community
  assert.equal((await bob.a.post(`/api/v1/servers/${nsid}/join`)).status, 200);
  assert.equal((await api(base).get('/.well-known/bonfire')).body.community.member_count, 3);
});

test('logout revokes the session', async () => {
  const x = await register('frank');
  assert.equal((await x.a.post('/api/v1/auth/logout')).status, 200);
  assert.equal((await x.a.get('/api/v1/me')).status, 401);
});
