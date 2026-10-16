'use strict';
// Voice signalling against a stubbed Cloudflare Realtime.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tmpDir, api, wsClient } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_OWNER;
const { startServer } = require('../src/index');
const voice = require('../src/voice');

const dir = tmpDir();
let inst, calls = [], n = 0;
const SDP = 'v=0\r\n' + 'a=x\r\n'.repeat(10);
const stub = async (url, init) => {
  calls.push(`${init.method} ${url.replace('https://rtc.live.cloudflare.com/v1', '')} auth=${init.headers.Authorization}`);
  const body = init.body ? JSON.parse(init.body) : {};
  let out = {};
  if (/sessions\/new$/.test(url)) out = { sessionId: 'sess' + ++n };
  else if (/generate-ice-servers$/.test(url)) out = { iceServers: [{ urls: ['stun:stun.example:3478'] }] };
  else if (/tracks\/new$/.test(url)) out = { sessionDescription: { type: 'answer', sdp: SDP }, tracks: body.tracks.map((t, i) => ({ trackName: t.trackName, mid: String(i), sessionId: t.sessionId })) };
  else if (/\/sessions\/[^/]+$/.test(url)) out = { tracks: [] };
  return { ok: true, status: 200, json: async () => out };
};

test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1' }); voice.setFetch(stub); });
test.after(async () => { voice.setFetch(null); await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('join, publish, connect, subscribe, leave; permissions and limits', async () => {
  const reg = async u => { const r = await api(inst.url).post('/api/v1/auth/register', { username: u, password: 'password123' }); return { ...r.body, a: api(inst.url, r.body.session) }; };
  const alice = await reg('alice'), bob = await reg('bob'), mallory = await reg('mallory');
  const d = (await alice.a.post('/api/v1/servers', { name: 'Voice', join_policy: 'open' })).body;
  const sid = d.server.sid, vc = d.channels.find(c => c.type === 'voice').cid, room = 'bf_' + vc;
  await bob.a.post(`/api/v1/servers/${sid}/join`);
  const wa = await wsClient(inst.url).login(alice.session), wb = await wsClient(inst.url).login(bob.session), wm = await wsClient(inst.url).login(mallory.session);

  // not configured yet
  wa.send({ type: 'chat_rtc_join', nonce: 'j0', room });
  assert.equal((await wa.waitFor(f => f.nonce === 'j0')).error, 'voice_unavailable');
  await alice.a.patch('/api/v1/instance/settings', { voice: { cf_app_id: 'app', cf_app_secret: 'sec', cf_turn_key_id: 'key', cf_turn_token: 'tok' } }).then(r => assert.equal(r.status, 403)); // not an admin yet
  const claim = await alice.a.post('/api/v1/instance/claim', { code: inst.setup.current() });
  assert.equal(claim.status, 200);
  const set = await alice.a.patch('/api/v1/instance/settings', { voice: { cf_app_id: 'app', cf_app_secret: 'sec', cf_turn_key_id: 'key', cf_turn_token: 'tok' } });
  assert.equal(set.status, 200);
  assert.equal((await api(inst.url).get('/.well-known/bonfire')).body.features.voice, true);

  // outsiders are refused
  wm.send({ type: 'chat_rtc_join', nonce: 'm1', room });
  assert.equal((await wm.waitFor(f => f.nonce === 'm1')).error, 'not_a_member');

  wa.send({ type: 'chat_rtc_join', nonce: 'j1', room });
  const joined = await wa.waitFor(f => f.type === 'chat_rtc_joined');
  assert.deepEqual(joined.people, []);
  assert.equal(joined.iceServers[0].urls[0], 'stun:stun.example:3478');
  assert.ok(calls.some(c => c.includes('/apps/app/sessions/new') && c.endsWith('auth=Bearer sec')));
  assert.ok(calls.some(c => c.includes('/turn/keys/key/credentials/generate-ice-servers') && c.endsWith('auth=Bearer tok')));
  wa.send({ type: 'chat_rtc_publish', nonce: 'p1', room, sessionDescription: { type: 'offer', sdp: SDP }, tracks: [{ mid: '0', trackName: 'audio' }, { mid: '1', trackName: 'bogus' }] });
  const pub = await wa.waitFor(f => f.type === 'chat_rtc_published');
  assert.deepEqual(pub.tracks.map(t => t.trackName), ['audio']);
  // not visible until the browser confirms a connection
  assert.equal((await alice.a.get(`/api/v1/servers/${sid}`)).body.voice[vc].length, 0);
  wa.send({ type: 'chat_rtc_connected', room });
  const st = await wb.waitFor(f => f.type === 'chat_voice_state');
  assert.deepEqual(st.users.map(u => u.username), ['alice']);
  assert.equal(st.channel, vc);
  assert.equal(st.server, sid);
  assert.equal((await bob.a.get(`/api/v1/servers/${sid}`)).body.voice[vc][0].username, 'alice');

  wb.send({ type: 'chat_rtc_join', nonce: 'j2', room });
  const j2 = await wb.waitFor(f => f.type === 'chat_rtc_joined');
  assert.equal(j2.people[0].userId, alice.user.id);
  wb.send({ type: 'chat_rtc_subscribe', nonce: 's1', room, sources: [{ userId: alice.user.id, trackName: 'audio' }] });
  const offer = await wb.waitFor(f => f.type === 'chat_rtc_offer');
  assert.equal(offer.tracks[0].userId, alice.user.id);
  wb.send({ type: 'chat_rtc_answer', nonce: 'a1', room, session: 'receive', sessionDescription: { type: 'answer', sdp: SDP } });
  assert.equal((await wb.waitFor(f => f.type === 'chat_rtc_ready' && f.nonce === 'a1')).session, 'receive');
  wb.send({ type: 'chat_rtc_ice', nonce: 'i1', room });
  assert.equal((await wb.waitFor(f => f.nonce === 'i1')).session, 'ice');
  // frames from a socket that never joined
  wm.send({ type: 'chat_rtc_publish', nonce: 'x', room, sessionDescription: { type: 'offer', sdp: SDP }, tracks: [] });
  assert.equal((await wm.waitFor(f => f.nonce === 'x' && f.type === 'chat_error')).error, 'not_in_voice');

  // leaving (socket close) clears the voice state
  wa.send({ type: 'chat_rtc_leave' });
  const empty = await wb.waitFor(f => f.type === 'chat_voice_state' && f.users.length === 0);
  assert.equal(empty.users.length, 0);

  // user_limit (Manage channels bypasses it; bob doesn't have that)
  wb.send({ type: 'chat_rtc_leave' });
  await alice.a.patch(`/api/v1/channels/${vc}`, { config: { user_limit: 1 } });
  wa.send({ type: 'chat_rtc_join', nonce: 'j3', room });
  await wa.waitFor(f => f.type === 'chat_rtc_joined' && f.nonce === 'j3');
  wa.send({ type: 'chat_rtc_connected', room });
  await wb.waitFor(f => f.type === 'chat_voice_state' && f.users.length === 1 && f.users[0].username === 'alice' && wb.frames.filter(x => x.type === 'chat_voice_state').length >= 3);
  wb.send({ type: 'chat_rtc_join', nonce: 'j4', room });
  assert.equal((await wb.waitFor(f => f.nonce === 'j4' && f.type === 'chat_error')).error, 'channel_full');
  [wa, wb, wm].forEach(w => w.close());
});
