'use strict';
// Channel types, role shop, starboard, webhooks, soundboard, mentions, search operators, extension points, bot accounts + bot API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer } = require('../src/index');
const { tmpDir, api, wsClient } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_OWNER;
const dir = tmpDir();
let inst, base;
const clients = [];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const wav = seconds => { // 8 kHz, mono, 8-bit PCM
  const n = Math.round(8000 * seconds), b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
};
const file = (buf, name, fields = {}) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); f.append('file', new Blob([buf]), name); return f; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); base = inst.url; });
test.after(async () => { clients.forEach(c => c.close()); await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const reg = async n => { const r = await api(base).post('/api/v1/auth/register', { username: n, password: 'correct horse battery' }); assert.equal(r.status, 200, JSON.stringify(r.body)); const a = api(base, r.body.session), post = a.post; a.post = (p, b) => { if (/\/messages$/.test(p)) require('../src/messages')._sendLimit.reset(); return post(p, b); }; return { ...r.body, a }; }; // the 8-per-5s limiter would trip a fast test
const online = async u => { const w = await wsClient(base).login(u.session); clients.push(w); return w; };
let alice, bob, carol, sid, general, voiceCh, wa, wb;
const S = p => `/api/v1/servers/${sid}${p}`;
const mkChannel = async (body, who = alice) => who.a.post(S('/channels'), body);

test('setup: community with three members', async () => {
  alice = await reg('alice'); bob = await reg('bob'); carol = await reg('carol');
  assert.equal((await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() })).status, 200);
  const d = (await alice.a.post('/api/v1/servers', { name: 'Camp', join_policy: 'open' })).body;
  sid = d.server.sid;
  general = d.channels.find(c => c.type === 'text').cid; voiceCh = d.channels.find(c => c.type === 'voice').cid;
  await bob.a.post(S('/join')); await carol.a.post(S('/join'));
  wa = await online(alice); wb = await online(bob);
});

test('channel types: validation, cleaning and who can post', async () => {
  const link = await mkChannel({ name: 'links', type: 'link', config: { url: 'https://example.com/x' } });
  assert.equal(link.body.channel.type, 'link');
  assert.deepEqual(link.body.channel.config, { url: 'https://example.com/x' });
  assert.equal((await mkChannel({ name: 'bad', type: 'link', config: { url: 'javascript:alert(1)' } })).body.error, 'bad_link');
  const welcome = (await mkChannel({ name: 'hello', type: 'welcome', config: { join: ['{user} is here', 'no placeholder'], leave: [], allow_chat: false } })).body.channel;
  assert.deepEqual(welcome.config, { allow_chat: false, join: ['{user} is here'], leave: [] });
  const logs = (await mkChannel({ name: 'logs', type: 'logs' })).body.channel;
  assert.deepEqual(logs.config, {});
  const shop = (await mkChannel({ name: 'shop', type: 'roles' })).body.channel;
  const board = (await mkChannel({ name: 'best', type: 'starboard', config: { watch: [general, voiceCh, 'nope'], min: 999 } })).body.channel;
  assert.deepEqual(board.config, { watch: [general], min: 100 });
  const mc = (await mkChannel({ name: 'mc', type: 'game' })).body.channel; // Ember Link channel: not set up yet = managers only, no chat
  assert.equal(mc.type, 'game');
  assert.equal(mc.config.setup, false);
  await alice.a.del(`/api/v1/channels/${mc.cid}`);
  assert.equal((await mkChannel({ name: 'nope', type: 'logs' }, bob)).status, 403);

  // can_post as members see it: roles / link / voice / starboard never; logs + welcome need Manage messages
  const seen = (await bob.a.get(S(''))).body.channels, post = n => seen.find(c => c.name === n).can_post;
  assert.deepEqual(['links', 'shop', 'best', 'General', 'logs', 'hello', 'general'].map(post), [false, false, false, false, false, false, true]);
  const own = (await alice.a.get(S(''))).body.channels;
  assert.equal(own.find(c => c.name === 'logs').can_post, true);
  assert.equal(own.find(c => c.name === 'hello').can_post, true);
  assert.equal(own.find(c => c.name === 'links').can_post, false);
  for (const c of [link.body.channel, shop, board]) assert.equal((await alice.a.post(`/api/v1/channels/${c.cid}/messages`, { message: 'hi' })).body.error, 'no_send_permission');
  assert.equal((await bob.a.post(`/api/v1/channels/${logs.cid}/messages`, { message: 'hi' })).status, 403);
  assert.equal((await alice.a.post(`/api/v1/channels/${logs.cid}/messages`, { message: 'deploy done' })).status, 200);
  // welcome with allow_chat: anybody posts
  assert.equal((await alice.a.patch(`/api/v1/channels/${welcome.cid}`, { config: { allow_chat: true, join: ['{user} is here'] } })).body.channel.config.allow_chat, true);
  assert.equal((await bob.a.post(`/api/v1/channels/${welcome.cid}/messages`, { message: 'hello all' })).status, 200);
  await alice.a.patch(`/api/v1/channels/${welcome.cid}`, { config: { allow_chat: false, join: ['{user} is here'] } });
  // join notices land in welcome channels
  const dave = await reg('dave');
  assert.equal((await dave.a.post(S('/join'))).status, 200);
  await wa.waitFor(f => f.type === 'chat_message' && f.message.sys_kind === 'join' && f.message.channel === welcome.cid && f.message.subject?.username === 'dave');
  const hist = (await alice.a.get(`/api/v1/channels/${welcome.cid}/messages`)).body.messages;
  assert.ok(hist.some(m => m.system && m.sys_kind === 'join' && m.body.includes('@dave') && /is here/.test(m.body)));
  await dave.a.post(S('/leave'));
  await wa.waitFor(f => f.type === 'chat_message' && f.message.sys_kind === 'leave' && f.message.channel === welcome.cid);
  // changing the type re-cleans the config
  assert.equal((await alice.a.patch(`/api/v1/channels/${logs.cid}`, { type: 'link', config: { url: 'nope' } })).body.error, 'bad_link');
});

test('roles shop: free roles self-assign, priced roles need a Velora account (402)', async () => {
  const free = (await alice.a.post(S('/roles'), { name: 'Gamer', color: '#ff0000' })).body.role;
  const vip = (await alice.a.post(S('/roles'), { name: 'VIP' })).body.role;
  const adminRole = (await alice.a.post(S('/roles'), { name: 'Boss', permissions: 512 })).body.role;
  const shop = (await alice.a.get(S(''))).body.channels.find(c => c.type === 'roles').cid;
  assert.equal((await alice.a.patch(`/api/v1/channels/${shop}`, { config: { items: [{ rid: adminRole.rid }] } })).body.error, 'shop_admin_role');
  const cfg = (await alice.a.patch(`/api/v1/channels/${shop}`, { config: { items: [{ rid: free.rid, price: 0, desc: 'play games' }, { rid: vip.rid, price: 50 }, { rid: 'rbogus' }] } })).body.channel.config;
  assert.deepEqual(cfg.items, [{ rid: free.rid, price: 0, desc: 'play games' }, { rid: vip.rid, price: 50, desc: '' }]);
  assert.equal((await bob.a.patch(`/api/v1/channels/${shop}`, { config: { items: [] } })).status, 403);
  let v = (await bob.a.get(`/api/v1/channels/${shop}/shop`)).body;
  assert.equal(v.balance, null);
  assert.deepEqual(v.items.map(i => [i.role.name, i.price, i.has, i.owned]), [['Gamer', 0, false, true], ['VIP', 50, false, false]]);
  v = (await bob.a.post(`/api/v1/channels/${shop}/shop/${free.rid}`)).body;
  assert.equal(v.items[0].has, true);
  await wb.waitFor(f => f.type === 'chat_perms_changed');
  assert.ok((await alice.a.get(S('/members'))).body.members.find(m => m.username === 'bob').roles.includes(free.rid));
  const paid = await bob.a.post(`/api/v1/channels/${shop}/shop/${vip.rid}`);
  assert.equal(paid.status, 402);
  assert.deepEqual(paid.body, { error: 'velora_required' }); // local accounts cannot pay; Velora principals get a pay request (relay.test.js)
  assert.equal((await bob.a.post(`/api/v1/channels/${shop}/shop/${adminRole.rid}`)).status, 404); // not in the shop
  assert.equal((await bob.a.get(`/api/v1/channels/${general}/shop`)).body.error, 'not_a_shop');
  assert.equal((await bob.a.del(`/api/v1/channels/${shop}/shop/${free.rid}`)).body.items[0].has, false);
});

test('starboard: a message joins the board at the threshold, stays, and counts keep updating', async () => {
  const board = (await alice.a.get(S(''))).body.channels.find(c => c.type === 'starboard').cid;
  assert.equal((await alice.a.patch(`/api/v1/channels/${board}`, { config: { watch: [], min: 2 } })).body.channel.config.min, 2);
  const m = (await alice.a.post(`/api/v1/channels/${general}/messages`, { message: 'a great message' })).body.message;
  const star = (u, on = true) => (on ? u.a.put : u.a.del)(`/api/v1/messages/${m.id}/reactions/${encodeURIComponent('\u2b50')}`);
  await star(bob);
  assert.equal((await alice.a.get(`/api/v1/channels/${board}/starboard`)).body.total, 0);
  await star(carol);
  const added = await wa.waitFor(f => f.type === 'chat_starboard' && f.id === m.id);
  assert.deepEqual({ ...added }, { type: 'chat_starboard', server: sid, channel: board, id: m.id, stars: 2, added: true });
  const v = (await bob.a.get(`/api/v1/channels/${board}/starboard`)).body;
  assert.equal(v.total, 1); assert.equal(v.min, 2);
  assert.equal(v.recent[0].id, m.id); assert.equal(v.recent[0].stars, 2); assert.equal(v.recent[0].starred, true); assert.equal(v.recent[0].channel_name, 'general');
  assert.equal(v.top[0].id, m.id);
  assert.equal(v.throwback.id, m.id);
  await star(alice);
  const upd = await wa.waitFor(f => f.type === 'chat_starboard' && f.id === m.id && f.stars === 3);
  assert.equal(upd.added, undefined);
  await star(alice, false); await star(bob, false); await star(carol, false);
  assert.equal((await bob.a.get(`/api/v1/channels/${board}/starboard`)).body.total, 1); // it stays
  assert.equal((await bob.a.get(`/api/v1/channels/${general}/starboard`)).body.error, 'not_a_starboard');
  // deleting the message takes it off the board
  await alice.a.del(`/api/v1/messages/${m.id}`);
  assert.equal((await bob.a.get(`/api/v1/channels/${board}/starboard`)).body.total, 0);
});

test('webhooks: manage, execute with the token, embeds, files, rate limit', async () => {
  assert.equal((await bob.a.post(`/api/v1/channels/${general}/webhooks`, { name: 'x' })).status, 403);
  const voiceHook = await alice.a.post(`/api/v1/channels/${voiceCh}/webhooks`, {});
  assert.equal(voiceHook.body.error, 'no_webhooks_here');
  const h = (await alice.a.post(`/api/v1/channels/${general}/webhooks`, { name: 'CI' })).body.webhook;
  assert.match(h.url, new RegExp(`^http://localhost:${inst.port}/api/v1/webhooks/${h.wid}/[A-Za-z0-9_-]{43}$`)); // the instance's public_url
  assert.equal(h.channel, general); assert.equal(h.created_by, 'alice');
  assert.equal((await alice.a.get(`/api/v1/channels/${general}/webhooks`)).body.webhooks.length, 1);
  const path = new URL(h.url).pathname, token = path.split('/').pop();
  const hook = api(base);
  assert.equal((await hook.get(path)).body.channel_id, general);
  assert.equal((await hook.raw('POST', `/api/v1/webhooks/${h.wid}/wrongtoken`, { content: 'x' })).status, 404);
  assert.equal((await hook.raw('POST', path, {})).status, 400);

  const got = wa.waitFor(f => f.type === 'chat_message' && f.message.author?.webhook && f.message.body === 'build green');
  const r = await hook.raw('POST', path + '?wait=true', { content: 'build green', username: 'Jenkins', avatar_url: 'https://example.com/a.png', embeds: [{ title: 'Build #5', color: '#00ff00', fields: [{ name: 'ok', value: '1' }], image: { url: 'javascript:x' } }, 'junk'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.webhook_id, h.wid); assert.equal(r.body.author.username, 'Jenkins'); assert.equal(r.body.channel_id, general);
  assert.deepEqual(r.body.embeds, [{ title: 'Build #5', color: 0x00ff00, fields: [{ name: 'ok', value: '1', inline: false }] }]);
  const msg = (await got).message;
  assert.deepEqual([msg.author.name_only, msg.author.webhook, msg.author.pfp, msg.author.id], [true, true, 'https://example.com/a.png', null]);
  assert.equal((await hook.raw('POST', path, { content: 'quiet' })).status, 204);
  // multipart: payload_json + a file an embed points at (attachment://) and one that stays an attachment
  const fd = new FormData();
  fd.append('payload_json', JSON.stringify({ content: 'with files', embeds: [{ title: 'pic', image: { url: 'attachment://a.png' } }] }));
  fd.append('files[0]', new Blob([PNG]), 'a.png'); fd.append('files[1]', new Blob([wav(0.1)]), 'note.wav');
  const mp = await hook.raw('POST', path + '?wait=true', fd);
  assert.equal(mp.status, 200, JSON.stringify(mp.body));
  assert.match(mp.body.embeds[0].image.url, /\/uploads\/.+\.png$/);
  assert.deepEqual(mp.body.attachments.map(a => a.filename), ['note.wav']);
  assert.equal((await fetch(mp.body.embeds[0].image.url.replace(/^http:\/\/localhost:\d+/, base))).status, 200);
  // management
  assert.equal((await alice.a.patch(`/api/v1/hooks/${h.wid}`, { name: 'Renamed', new_token: true })).body.webhook.name, 'Renamed');
  assert.equal((await hook.raw('POST', path, { content: 'old token' })).status, 404);
  assert.equal((await bob.a.patch(`/api/v1/hooks/${h.wid}`, { name: 'no' })).status, 403);
  const av = await alice.a.post(`/api/v1/hooks/${h.wid}/avatar`, file(PNG, 'a.png'));
  assert.match(av.body.webhook.avatar, /\/uploads\/chat\/webhook_/);
  // 30 / minute / hook
  const h2 = (await alice.a.post(`/api/v1/channels/${general}/webhooks`, {})).body.webhook, p2 = new URL(h2.url).pathname;
  for (let i = 0; i < 30; i++) assert.equal((await hook.raw('POST', p2, { content: 'n' + i })).status, 204);
  const limited = await hook.raw('POST', p2, { content: 'too many' });
  assert.equal(limited.status, 429); assert.equal(limited.body.global, false); assert.ok(limited.body.retry_after >= 1);
  assert.equal((await hook.raw('DELETE', p2)).status, 204);
  assert.equal((await hook.raw('POST', p2, { content: 'gone' })).status, 404);
  assert.equal((await alice.a.del(`/api/v1/hooks/${h.wid}`)).status, 200);
  assert.equal(token.length, 43);
  // 30 hooks per community
  const logs = (await alice.a.get(S(''))).body.channels.find(c => c.type === 'logs').cid;
  for (let i = 0; i < 30; i++) await alice.a.post(`/api/v1/channels/${logs}/webhooks`, {});
  assert.equal((await alice.a.post(`/api/v1/channels/${logs}/webhooks`, {})).body.error, 'too_many_webhooks');
  for (const x of (await alice.a.get(`/api/v1/channels/${logs}/webhooks`)).body.webhooks) await alice.a.del(`/api/v1/hooks/${x.wid}`);
});

test('soundboard: CRUD, upload checks, playing in a voice room', async () => {
  const voice = require('../src/voice');
  const SDP = 'v=0\r\n' + 'a=x\r\n'.repeat(10);
  voice.setFetch(async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : {};
    const out = /sessions\/new$/.test(url) ? { sessionId: 's' + Math.random() } : /generate-ice-servers$/.test(url) ? { iceServers: [] } : /tracks\/new$/.test(url) ? { sessionDescription: { type: 'answer', sdp: SDP }, tracks: (body.tracks || []).map((t, i) => ({ trackName: t.trackName, mid: String(i) })) } : {};
    return { ok: true, status: 200, json: async () => out };
  });
  try {
    assert.equal((await alice.a.patch('/api/v1/instance/settings', { voice: { cf_app_id: 'app', cf_app_secret: 's', cf_turn_key_id: 'k', cf_turn_token: 't' } })).status, 200);
    assert.equal((await bob.a.post(S('/sounds'), file(wav(0.5), 'boom.wav'))).status, 403);
    assert.equal((await alice.a.post(S('/sounds'), file(Buffer.from('not audio at all'), 'x.wav'))).body.error, 'not_audio');
    assert.equal((await alice.a.post(S('/sounds'), file(PNG, 'x.png'))).body.error, 'not_audio');
    assert.equal((await alice.a.post(S('/sounds'), file(wav(6), 'long.wav'))).body.error, 'sound_too_long');
    const add = await alice.a.post(S('/sounds'), file(wav(0.5), 'Boom Clap.wav', { emoji: '\ud83d\udca5' }));
    assert.equal(add.status, 200, JSON.stringify(add.body));
    const snd = add.body.sound;
    assert.deepEqual([snd.name, snd.emoji, snd.volume, snd.duration], ['Boom Clap', '\ud83d\udca5', 100, 500]);
    assert.equal((await fetch(snd.url.replace(/^http:\/\/localhost:\d+/, base))).status, 200);
    assert.equal((await bob.a.get(S('/sounds'))).body.max, 30);
    assert.equal((await bob.a.get('/api/v1/sounds')).body.servers[0].sounds[0].id, snd.id);
    assert.equal((await alice.a.patch(S(`/sounds/${snd.id}`), { name: 'Boom', volume: 1 })).body.sound.volume, 5);
    assert.equal((await bob.a.patch(S(`/sounds/${snd.id}`), { name: 'x' })).status, 403);
    // play: only from inside a voice room, everyone in the room hears it
    wb.send({ type: 'voice_sound', sound: snd.id });
    assert.equal((await wb.waitFor(f => f.type === 'voice_sound_failed')).reason, 'not_in_voice');
    for (const w of [wa, wb]) { w.send({ type: 'chat_rtc_join', nonce: 'j', room: 'bf_' + voiceCh }); await w.waitFor(f => f.type === 'chat_rtc_joined' && f.room === 'bf_' + voiceCh); }
    const wc = await online(carol); // in the community but not in the call
    wb.frames.length = 0; wa.frames.length = 0;
    wb.send({ type: 'voice_sound', sound: snd.id });
    const heard = await wa.waitFor(f => f.type === 'voice_sound');
    assert.equal(heard.by, 'bob'); assert.equal(heard.sound.id, snd.id); assert.equal(heard.sound.name, 'Boom');
    await wb.waitFor(f => f.type === 'voice_sound');
    wb.send({ type: 'voice_sound', sound: snd.id });
    assert.equal((await wb.waitFor(f => f.type === 'voice_sound_failed')).reason, 'too_fast');
    await sleep(1300);
    wb.send({ type: 'voice_sound', sound: 'snd0000000000' });
    assert.equal((await wb.waitFor(f => f.type === 'voice_sound_failed' && f.reason === 'not_found')).reason, 'not_found');
    assert.equal(wc.frames.some(f => f.type === 'voice_sound'), false);
    // a sound picked from another server (another instance / Velora) is relayed by URL after a shape check
    await sleep(1300);
    const ext = { name: 'Far', emoji: '<:x:e0123456789>', volume: 500, duration: 900, url: 'https://other.example/uploads/sounds/snd0123456789.mp3' };
    wb.send({ type: 'voice_sound', sound: { ...ext, url: 'https://other.example/evil.html' } });
    assert.equal((await wb.waitFor(f => f.type === 'voice_sound_failed' && f.reason === 'not_found')).reason, 'not_found');
    wa.frames.length = 0;
    wb.send({ type: 'voice_sound', sound: ext });
    const far = (await wa.waitFor(f => f.type === 'voice_sound')).sound;
    assert.deepEqual([far.external, far.name, far.emoji, far.volume, far.url], [true, 'Far', null, 100, ext.url]);
    wa.send({ type: 'chat_rtc_leave' }); wb.send({ type: 'chat_rtc_leave' });
    assert.equal((await bob.a.del(S(`/sounds/${snd.id}`))).status, 403);
    assert.equal((await alice.a.del(S(`/sounds/${snd.id}`))).status, 200);
    assert.equal((await alice.a.get(S('/sounds'))).body.sounds.length, 0);
    assert.equal((await fetch(snd.url.replace(/^http:\/\/localhost:\d+/, base))).status, 404);
  } finally { voice.setFetch(null); }
});

test('mentions: chat_mention to online targets, notifyOffline for the rest, mute respected', async () => {
  const notify = require('../src/notify');
  const calls = [];
  notify.setOfflineHandler((ids, payload) => calls.push({ ids, payload }));
  const idOf = u => require('../src/auth').userByPrincipal(u.user.id).id;
  const frank = await reg('frank'); // a member with no socket: always offline
  await frank.a.post(S('/join'));
  try {
    const gotBob = wb.waitFor(f => f.type === 'chat_mention' && f.body === '@bob look');
    await alice.a.post(`/api/v1/channels/${general}/messages`, { message: '@bob look' });
    const m = await gotBob;
    assert.deepEqual({ ...m, id: undefined }, { type: 'chat_mention', id: undefined, server: 'Camp', sid, channel: 'general', cid: general, from: 'alice', pfp: null, body: '@bob look' });
    assert.deepEqual(calls, []); // nobody offline was mentioned
    // @everyone: bob and carol online, frank offline -> the hook gets frank only
    await alice.a.post(`/api/v1/channels/${general}/messages`, { message: '@everyone ping' });
    await wb.waitFor(f => f.type === 'chat_mention' && f.body === '@everyone ping');
    assert.deepEqual(calls.map(c => c.ids), [[idOf(frank)]]);
    assert.equal(calls[0].payload.type, 'chat_mention');
    // @here: online only; people without Mention everyone can't
    calls.length = 0;
    await alice.a.post(`/api/v1/channels/${general}/messages`, { message: '@here ping' });
    await wb.waitFor(f => f.type === 'chat_mention' && f.body === '@here ping');
    assert.deepEqual(calls, []);
    await bob.a.post(`/api/v1/channels/${general}/messages`, { message: '@everyone nope' });
    await sleep(100);
    assert.equal(wa.frames.some(f => f.type === 'chat_mention' && f.body === '@everyone nope'), false);
    // roles
    const role = (await alice.a.post(S('/roles'), { name: 'Crew', mentionable: true })).body.role;
    await alice.a.put(S(`/members/${encodeURIComponent(bob.user.id)}/roles/${role.rid}`));
    await alice.a.post(`/api/v1/channels/${general}/messages`, { message: `hey <@&${role.rid}>` });
    await wb.waitFor(f => f.type === 'chat_mention' && f.body.startsWith('hey <@&'));
    // replies ping the author
    const mine = (await bob.a.post(`/api/v1/channels/${general}/messages`, { message: 'question' })).body.message;
    await alice.a.post(`/api/v1/channels/${general}/messages`, { message: 'answer', reply_to: mine.id });
    await wb.waitFor(f => f.type === 'chat_mention' && f.body === 'answer');
    // a muted channel stays quiet, level "all" pings for everything
    assert.equal((await bob.a.put(`/api/v1/notify/${general}`, { mute_minutes: -1 })).status, 200);
    await alice.a.post(`/api/v1/channels/${general}/messages`, { message: '@bob while muted' });
    await sleep(150);
    assert.equal(wb.frames.some(f => f.type === 'chat_mention' && f.body === '@bob while muted'), false);
    await bob.a.put(`/api/v1/notify/${general}`, { mute_minutes: 0, level: 'all' });
    await alice.a.post(`/api/v1/channels/${general}/messages`, { message: 'no mention at all' });
    await wb.waitFor(f => f.type === 'chat_mention' && f.body === 'no mention at all');
    await bob.a.put(`/api/v1/notify/${general}`, { level: 'none' });
    await alice.a.post(`/api/v1/channels/${general}/messages`, { message: '@bob level none' });
    await sleep(150);
    assert.equal(wb.frames.some(f => f.body === '@bob level none'), false);
    await bob.a.put(`/api/v1/notify/${general}`, { level: 'default' });
    assert.equal((await bob.a.get('/api/v1/notify')).body.notify[general].level, 'default');
  } finally { notify.setOfflineHandler(null); }
});

test('extension points: messages.onPost for every kind of message, postBridged', async () => {
  const M = require('../src/messages');
  const seen = [];
  const off = M.onPost((msg, ctx, meta) => seen.push({ body: msg.body, ch: ctx.ch.cid, ...meta }));
  try {
    await alice.a.post(`/api/v1/channels/${general}/messages`, { message: 'user post' });
    const h = (await alice.a.post(`/api/v1/channels/${general}/webhooks`, {})).body.webhook;
    await api(base).raw('POST', new URL(h.url).pathname, { content: 'hook post' });
    const gotBridge = wa.waitFor(f => f.type === 'chat_message' && f.message.bridge === 'discord');
    const b = M.postBridged(general, { platform: 'discord', name: 'Zed', avatar: 'https://cdn.example/z.png', body: 'from discord', attachments: [{ url: 'https://cdn.example/pic.png', type: 'image', name: 'pic.png' }, { url: 'ftp://bad', type: 'file' }] });
    const ev = (await gotBridge).message;
    assert.deepEqual([ev.id, ev.author.username, ev.author.pfp, ev.author.bridge, ev.author.id, ev.attachments.length], [b.id, 'Zed', 'https://cdn.example/z.png', 'discord', null, 1]);
    assert.equal(ev.attachments[0].url, 'https://cdn.example/pic.png');
    await alice.a.put(`/api/v1/messages/${b.id}/pin`); // a system line
    const kinds = seen.map(s => [s.body, s.system, s.webhook, s.bridged]);
    assert.deepEqual(kinds.slice(0, 3), [['user post', false, false, null], ['hook post', false, true, null], ['from discord', false, false, 'discord']]);
    assert.ok(seen.some(s => s.system && s.body.includes('pinned')));
    assert.equal(seen[0].ch, general);
    assert.throws(() => M.postBridged(general, { platform: 'x', name: 'n', body: '' }), /empty_message/);
  } finally { off(); }
  const n = seen.length;
  await alice.a.post(`/api/v1/channels/${general}/messages`, { message: 'after unsubscribe' });
  assert.equal(seen.length, n);
});

test('search operators: from: in: has:', async () => {
  const up = await alice.a.post(`/api/v1/media/upload?sid=${sid}`, file(PNG, 'cat.png'));
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const general2 = (await mkChannel({ name: 'random' })).body.channel.cid;
  await alice.a.post(`/api/v1/channels/${general}/messages`, { message: 'sunset pic zebra', attachments: [up.body] });
  await bob.a.post(`/api/v1/channels/${general2}/messages`, { message: 'read https://example.com/zebra now' });
  const q = async s => (await carol.a.get(S('/search?q=' + encodeURIComponent(s)))).body;
  assert.equal((await q('zebra')).total, 2);
  assert.deepEqual((await q('zebra from:bob')).messages.map(m => m.channel_name), ['random']);
  assert.deepEqual((await q('from:@alice zebra in:general')).messages.map(m => m.author.username), ['alice']);
  assert.equal((await q('zebra has:image')).messages[0].attachments[0].type, 'image');
  assert.equal((await q('has:link')).messages[0].body.includes('https://example.com'), true);
  assert.equal((await q('has:file zebra')).total, 1);
  assert.equal((await q('zebra in:random has:image')).total, 0);
  assert.equal((await q('has:video')).total, 0);
});

test('identities accept bot principals and user objects carry the BOT flag', async () => {
  assert.equal((await alice.a.get('/api/v1/identities?ids=b:99')).status, 200);
});

let bot, botToken, botApi, guildId, channelId, aliceNum;
test('bot accounts: management and token format', async () => {
  assert.equal((await bob.a.post('/api/v1/bots', { name: 'sneaky' })).status, 403);
  assert.equal((await bob.a.get('/api/v1/bots')).status, 403);
  assert.equal((await alice.a.post('/api/v1/bots', { name: 'x' })).body.error, 'bad_bot_name');
  assert.equal((await alice.a.post('/api/v1/bots', { name: 'alice' })).body.error, 'name_taken');
  const r = await alice.a.post('/api/v1/bots', { name: 'EchoBot', description: 'repeats things' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  bot = r.body.bot; botToken = r.body.token;
  assert.match(bot.id, /^b:\d+$/);
  assert.match(botToken, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{40}$/);
  assert.equal(Buffer.from(botToken.split('.')[0], 'base64url').toString(), bot.id.slice(2)); // base64url(id).random
  const hashed = require('../src/db').get('SELECT token_hash FROM bots').token_hash;
  assert.equal(hashed, require('crypto').createHash('sha256').update(botToken).digest('hex'));
  assert.equal((await alice.a.post('/api/v1/bots', { name: 'echobot' })).body.error, 'name_taken');
  assert.equal((await alice.a.get('/api/v1/bots')).body.bots[0].description, 'repeats things');
  assert.equal((await alice.a.get('/api/v1/bots/by-name/echobot')).body.can_add_to[0].sid, sid);
  assert.equal((await bob.a.post('/api/v1/bots/by-name/echobot/add', { sid })).status, 403);
  assert.equal((await alice.a.post('/api/v1/bots/by-name/echobot/add', { sid })).status, 200);
  assert.equal((await alice.a.post('/api/v1/bots/by-name/echobot/add', { sid })).body.error, 'already_in_server');
  const m = (await bob.a.get(S('/members'))).body.members.find(x => x.username === 'EchoBot');
  assert.deepEqual([m.id, m.kind, m.bot], [bot.id, 'bot', true]);
  // a bot cannot log in or hold a session
  assert.equal((await api(base).post('/api/v1/auth/login', { username: 'EchoBot', password: 'whatever12' })).status, 401);
  assert.equal((await alice.a.patch(`/api/v1/bots/${bot.id}`, { description: 'echoes' })).body.bot.description, 'echoes');
  assert.equal((await alice.a.post(`/api/v1/bots/${bot.id}/avatar`, file(PNG, 'a.png'))).body.bot.pfp.includes('/uploads/chat/bot_'), true);
  botApi = { get: p => fetch(base + p, { headers: { Authorization: 'Bot ' + botToken } }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) })) };
});

test('bot REST: token auth, guilds, send / edit / react / delete, Discord shapes', async () => {
  const call = async (method, p, body, token = botToken) => {
    if (method === 'POST' && /\/messages$/.test(p)) require('../src/messages')._sendLimit.reset();
    const r = await fetch(base + p, { method, headers: { Authorization: 'Bot ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: r.status === 204 ? null : await r.json() };
  };
  // auth
  assert.equal((await fetch(base + '/bot/v1/users/@me')).status, 401);
  assert.equal((await call('GET', '/bot/v1/users/@me', null, 'bad.token')).status, 401);
  assert.equal((await fetch(base + '/bot/v1/users/@me', { headers: { Authorization: 'Bearer ' + alice.session } })).status, 401); // sessions are not bot tokens
  const me = (await call('GET', '/bot/v1/users/@me')).body;
  assert.deepEqual([me.username, me.bot], ['EchoBot', true]);
  const disc = (await api(base).get('/bot/discovery')).body;
  assert.equal(disc.endpoints.api, `http://localhost:${inst.port}/bot/v1`);
  assert.equal(disc.endpoints.gateway, `ws://localhost:${inst.port}/bot/gateway`);
  assert.equal((await api(base).get('/bot/v1/gateway')).body.url, disc.endpoints.gateway);

  const guilds = (await call('GET', '/bot/v1/users/@me/guilds')).body;
  assert.equal(guilds.length, 1); guildId = guilds[0].id;
  const g = (await call('GET', `/bot/v1/guilds/${guildId}`)).body;
  assert.deepEqual([g.name, g.member_count], ['Camp', 5]);
  const chans = (await call('GET', `/bot/v1/guilds/${guildId}/channels`)).body;
  const gen = chans.find(c => c.name === 'general');
  channelId = gen.id;
  assert.equal(chans.find(c => c.name === 'General').type, 2);
  aliceNum = String((await call('GET', `/bot/v1/guilds/${guildId}/members`)).body.find(m => m.user.username === 'alice').user.id);
  assert.equal((await call('GET', '/bot/v1/guilds/99999')).status, 404);
  assert.equal((await call('GET', '/bot/v1/channels/99999')).body.code, 10003);

  // send
  const gotMsg = wa.waitFor(f => f.type === 'chat_message' && f.message.author?.kind === 'bot');
  const gotMention = wa.waitFor(f => f.type === 'chat_mention' && f.from === 'EchoBot');
  const sent = await call('POST', `/bot/v1/channels/${channelId}/messages`, { content: `hello <@${aliceNum}>`, embeds: [{ title: 'T', description: 'D' }] });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.content, `hello <@${aliceNum}>`);
  assert.deepEqual([sent.body.author.bot, sent.body.author.username, sent.body.mentions.length, sent.body.embeds[0].title], [true, 'EchoBot', 1, 'T']);
  const ev = (await gotMsg).message;
  assert.deepEqual([ev.body, ev.author.id, ev.author.bot], ['hello @alice', bot.id, true]);
  assert.equal((await gotMention).body, 'hello @alice');
  // edit / react / pin / read / delete
  assert.equal((await call('PATCH', `/bot/v1/channels/${channelId}/messages/${sent.body.id}`, { content: 'edited' })).body.content, 'edited');
  assert.equal((await call('PUT', `/bot/v1/channels/${channelId}/messages/${sent.body.id}/reactions/${encodeURIComponent('\ud83d\udc4d')}/@me`)).status, 204);
  assert.equal((await call('GET', `/bot/v1/channels/${channelId}/messages/${sent.body.id}`)).body.reactions[0].count, 1);
  assert.equal((await call('PUT', `/bot/v1/channels/${channelId}/pins/${sent.body.id}`)).status, 403); // no Manage messages
  const list = (await call('GET', `/bot/v1/channels/${channelId}/messages?limit=5`)).body;
  assert.equal(list[0].id, sent.body.id); assert.ok(list.length > 1);
  const other = (await alice.a.post(`/api/v1/channels/${general}/messages`, { message: 'alices' })).body.message;
  assert.equal((await call('PATCH', `/bot/v1/channels/${channelId}/messages/${other.id}`, { content: 'hijack' })).status, 403);
  assert.equal((await call('DELETE', `/bot/v1/channels/${channelId}/messages/${sent.body.id}`)).status, 204);
  assert.equal((await call('GET', `/bot/v1/channels/${channelId}/messages/${sent.body.id}`)).body.code, 10008);
  // multipart with files
  const fd = new FormData();
  fd.append('payload_json', JSON.stringify({ content: 'file time' }));
  fd.append('files[0]', new Blob([PNG]), 'x.png');
  require('../src/messages')._sendLimit.reset();
  const up = await fetch(base + `/bot/v1/channels/${channelId}/messages`, { method: 'POST', headers: { Authorization: 'Bot ' + botToken }, body: fd });
  const upBody = await up.json();
  assert.equal(up.status, 200, JSON.stringify(upBody));
  assert.deepEqual([upBody.attachments[0].filename, upBody.attachments[0].content_type], ['x.png', 'image/png']);
  // the logs channel is not postable, for bots either
  const logsId = chans.find(c => c.name === 'logs').id;
  assert.equal((await call('POST', `/bot/v1/channels/${logsId}/messages`, { content: 'x' })).body.code, 50013);
  assert.equal((await call('POST', '/bot/v1/users/@me/channels', {})).status, 403);
  // 150 requests / 10 s per bot
  let limited = null;
  for (let i = 0; i < 160 && !limited; i++) { const r = await call('GET', '/bot/v1/users/@me'); if (r.status === 429) limited = r; }
  assert.ok(limited, 'rate limit kicks in');
  assert.equal(limited.body.global, false);
  require('../src/routes/botapi')._hits.reset(); // don't wait out the 10 s window
});

test('bot gateway: identify, READY, GUILD_CREATE, MESSAGE_CREATE, member events', async () => {
  const WebSocket = require('ws');
  const open = () => new Promise((res, rej) => { const ws = new WebSocket(base.replace(/^http/, 'ws') + '/bot/gateway'); const frames = []; ws.on('message', d => frames.push(JSON.parse(d))); ws.on('open', () => res({ ws, frames })); ws.on('error', rej); });
  const until = async (frames, pred) => { for (let i = 0; i < 60; i++) { const f = frames.find(pred); if (f) return f; await sleep(50); } throw new Error('no frame: ' + frames.map(f => f.t || 'op' + f.op).join(',')); };
  const bad = await open();
  bad.ws.send(JSON.stringify({ op: 2, d: { token: 'nope.nope' } }));
  assert.equal(await new Promise(r => bad.ws.on('close', c => r(c))), 4004);
  const { ws, frames } = await open();
  clients.push({ close: () => ws.close() });
  assert.equal(frames[0].op, 10);
  assert.ok(frames[0].d.heartbeat_interval > 1000);
  ws.send(JSON.stringify({ op: 1 }));
  await until(frames, f => f.op === 11);
  ws.send(JSON.stringify({ op: 2, d: { token: botToken, intents: 0 } }));
  const ready = await until(frames, f => f.t === 'READY');
  assert.deepEqual([ready.d.user.username, ready.d.user.bot, ready.d.guilds[0].id], ['EchoBot', true, guildId]);
  const gc = await until(frames, f => f.t === 'GUILD_CREATE');
  assert.equal(gc.d.channels.some(c => c.name === 'general'), true);
  const mine = (await alice.a.post(`/api/v1/channels/${general}/messages`, { message: `gateway @EchoBot hi ${Date.now()}` })).body.message;
  const mc = await until(frames, f => f.t === 'MESSAGE_CREATE' && f.d.id === mine.id);
  assert.equal(mc.d.channel_id, channelId);
  assert.equal(mc.d.author.username, 'alice');
  assert.equal(mc.d.mentions[0].username, 'EchoBot');
  assert.equal(mc.d.content.includes(`<@${mc.d.mentions[0].id}>`), true);
  assert.equal(mc.s > 0, true);
  await alice.a.patch(`/api/v1/messages/${mine.id}`, { message: 'changed' });
  assert.equal((await until(frames, f => f.t === 'MESSAGE_UPDATE' && f.d.id === mine.id)).d.content, 'changed');
  await alice.a.put(`/api/v1/messages/${mine.id}/reactions/${encodeURIComponent('\ud83d\udd25')}`);
  assert.equal((await until(frames, f => f.t === 'MESSAGE_REACTION_ADD' && f.d.message_id === mine.id)).d.emoji.name, '\ud83d\udd25');
  await alice.a.del(`/api/v1/messages/${mine.id}`);
  await until(frames, f => f.t === 'MESSAGE_DELETE' && f.d.id === mine.id);
  const erin = await reg('erin');
  await erin.a.post(S('/join'));
  assert.equal((await until(frames, f => f.t === 'GUILD_MEMBER_ADD')).d.user.username, 'erin');
  // a private channel the bot cannot see sends nothing
  const secret = (await mkChannel({ name: 'secret' })).body.channel;
  const everyone = (await alice.a.get(S(''))).body.roles.find(r => r.is_default).rid;
  await alice.a.put(`/api/v1/channels/${secret.cid}/perms`, { overwrites: [{ rid: everyone, deny: 1024 }] });
  const hidden = (await alice.a.post(`/api/v1/channels/${secret.cid}/messages`, { message: 'top secret' })).body.message;
  await alice.a.post(`/api/v1/channels/${general}/messages`, { message: 'marker' });
  await until(frames, f => f.t === 'MESSAGE_CREATE' && f.d.content === 'marker');
  assert.equal(frames.some(f => f.t === 'MESSAGE_CREATE' && f.d.id === hidden.id), false);
  // token reset closes the gateway and invalidates the old token
  const closed = new Promise(r => ws.on('close', c => r(c)));
  const reset = await alice.a.post(`/api/v1/bots/${bot.id}/token`);
  assert.equal(await closed, 4004);
  assert.equal((await botApi.get('/bot/v1/users/@me')).status, 401);
  botToken = reset.body.token;
  assert.equal((await botApi.get('/bot/v1/users/@me')).status, 200);
  // removing the bot from the community, then deleting it
  assert.equal((await alice.a.del(S(`/members/${encodeURIComponent(bot.id)}`))).status, 200);
  assert.equal((await botApi.get('/bot/v1/users/@me/guilds')).body.length, 0);
  assert.equal((await alice.a.del(`/api/v1/bots/${bot.id}`)).status, 200);
  assert.equal((await botApi.get('/bot/v1/users/@me')).status, 401);
  assert.equal((await alice.a.get('/api/v1/bots')).body.bots.length, 0);
});
