'use strict';
// Velora-hosted ("managed") instances (PROTOCOL §19): plan limits from BONFIRE_PLAN / BONFIRE_LIMITS, locked settings, the `managed` object, voice quota frames.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer } = require('../src/index');
const auth = require('../src/auth');
const { tmpDir, api, wsClient, fakeIdp } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'velora';
process.env.BONFIRE_VELORA_URL = 'http://velora.test/';
process.env.BONFIRE_PUBLIC_URL = 'http://chat.test';
process.env.BONFIRE_OWNER = 'v:100';
process.env.BONFIRE_MANAGED = '1';
process.env.BONFIRE_PLAN = 'starter';
const LIMITS = { member_cap: 3, max_upload_mb: 1, emojis: 1, sounds: 1, bots: 1, bridges: false, custom_voice_keys: false };
process.env.BONFIRE_LIMITS = JSON.stringify(LIMITS);

const dir = tmpDir();
const idp = fakeIdp({ iss: 'http://velora.test', aud: 'http://chat.test' });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const file = (buf, name, fields = {}) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); f.append('file', new Blob([buf]), name); return f; };
let inst, base, owner, sid;
const clients = [];

test.before(async () => {
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} });
  base = inst.url;
  auth.setJwksFetcher(idp.jwks);
});
test.after(async () => { clients.forEach(c => c.close()); await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const login = async (sub, username) => {
  const r = await api(base).post('/api/v1/auth/velora', { token: idp.mint({ sub: String(sub), username }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...r.body, a: api(base, r.body.session) };
};

test('well-known and settings carry the managed object; the server shows its member cap', async () => {
  const wk = (await api(base).get('/.well-known/bonfire')).body;
  assert.deepEqual(wk.managed, { plan: 'starter', limits: LIMITS, host: 'velora' });
  assert.equal(wk.features.bridges, false);
  assert.equal(wk.max_upload_mb, 1);
  owner = await login(100, 'owner');
  const s = (await owner.a.get('/api/v1/instance/settings')).body;
  assert.deepEqual(s.managed, wk.managed);
  assert.equal(s.accounts_mode, 'velora');
  assert.equal(s.max_upload_mb, 1);
  const d = (await owner.a.post('/api/v1/servers', { name: 'Hosted', join_policy: 'open' })).body;
  sid = d.server.sid;
  assert.equal(d.server.member_cap, 3);
  assert.equal(d.server.upload_max_mb, 1);
});

test('member cap: people past it are refused, admins and bots are not counted or blocked', async () => {
  const S = p => `/api/v1/servers/${sid}${p}`;
  const u1 = await login(101, 'one'), u2 = await login(102, 'two'), u3 = await login(103, 'three'), adm = await login(104, 'adm');
  assert.equal((await u1.a.post(S('/join'))).status, 200);
  assert.equal((await u2.a.post(S('/join'))).status, 200); // owner + 2 = 3 people
  const full = await u3.a.post(S('/join'));
  assert.equal(full.status, 403);
  assert.deepEqual({ error: full.body.error, cap: full.body.cap }, { error: 'member_cap_reached', cap: 3 });
  const made = (await owner.a.post(S('/invites'), {})).body;
  const code = (made.invite || made).code;
  assert.ok(code);
  assert.equal((await u3.a.post(`/api/v1/join/${code}`)).body.error, 'member_cap_reached');
  // an instance admin joins anyway
  { const j = await owner.a.put('/api/v1/instance/admins/v:104'); assert.equal(j.status, 200, JSON.stringify(j.body)); }
  { const j = await adm.a.post(S("/join")); assert.equal(j.status, 200, JSON.stringify(j.body)); }
  // a request-policy community: the request is refused too
  assert.equal((await owner.a.patch(S(''), { join_policy: 'request' })).status, 200);
  assert.equal((await u3.a.post(S('/join'))).body.error, 'member_cap_reached');
  await owner.a.patch(S(''), { join_policy: 'open' });
  // bots do not count and are not blocked
  const bot = (await owner.a.post('/api/v1/bots', { name: 'helper' })).body;
  assert.equal(bot.bot.username, 'helper');
  assert.equal((await owner.a.post('/api/v1/bots/by-name/helper/add', { sid })).status, 200);
  assert.equal((await owner.a.get(S(''))).body.server.member_count, 5);
  // freeing a seat lets the next person in
  assert.equal((await u2.a.post(S('/leave'))).status, 200); // admins still count toward the cap once in: owner, one, adm = 3
  assert.equal((await u3.a.post(S('/join'))).body.error, 'member_cap_reached');
  assert.equal((await u1.a.post(S('/leave'))).status, 200);
  assert.equal((await u3.a.post(S('/join'))).status, 200);
});

test('plan_limit: emojis, soundboard, bots', async () => {
  const S = p => `/api/v1/servers/${sid}${p}`;
  assert.equal((await owner.a.raw('POST', S('/emojis'), file(PNG, 'a.png', { name: 'one' }))).status, 200);
  const two = await owner.a.raw('POST', S('/emojis'), file(PNG, 'b.png', { name: 'two' }));
  assert.equal(two.status, 403);
  assert.deepEqual({ error: two.body.error, what: two.body.what, limit: two.body.limit }, { error: 'plan_limit', what: 'emojis', limit: 1 });
  assert.equal((await owner.a.get(S('/emojis'))).body.max, 1);
  const bots = await owner.a.post('/api/v1/bots', { name: 'second' });
  assert.equal(bots.status, 403);
  assert.deepEqual({ what: bots.body.what, limit: bots.body.limit }, { what: 'bots', limit: 1 });
  assert.equal((await owner.a.get('/api/v1/bots')).body.max, 1);
  assert.equal((await owner.a.get(S('/sounds'))).body.max, 1);
});

test('uploads: the plan caps the file size and community upload_max_mb', async () => {
  const S = p => `/api/v1/servers/${sid}${p}`;
  const set = await owner.a.patch(S(''), { allow_uploads: true, upload_max_mb: 50 });
  assert.equal(set.body.server.upload_max_mb, 1);
  const big = await owner.a.raw('POST', `/api/v1/media/upload?sid=${sid}`, file(Buffer.alloc(1024 * 1024 + 10, 7), 'big.bin'));
  assert.equal(big.status, 413);
  const small = await owner.a.raw('POST', `/api/v1/media/upload?sid=${sid}`, file(PNG, 'ok.png'));
  assert.equal(small.status, 200);
  assert.equal((await owner.a.patch('/api/v1/instance/settings', { max_upload_mb: 400 })).body.max_upload_mb, 1);
});

test('locked settings, custom voice keys and bridges are refused', async () => {
  const P = body => owner.a.patch('/api/v1/instance/settings', body);
  for (const [k, v] of [['accounts_mode', 'local'], ['public_url', 'https://elsewhere.example'], ['velora_url', 'https://evil.example'], ['velora_registration', 'off']]) {
    const r = await P({ [k]: v });
    assert.equal(r.status, 403, k);
    assert.deepEqual({ error: r.body.error, setting: r.body.setting }, { error: 'managed_setting', setting: k });
  }
  // the current value is fine (the admin form sends everything back)
  const ok = await P({ accounts_mode: 'velora', public_url: 'http://chat.test', velora_registration: 'auto', name: 'Renamed' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.name, 'Renamed');
  const keys = await P({ voice: { cf_app_id: 'x', cf_app_secret: 'y', cf_turn_key_id: 'z', cf_turn_token: 'w' } });
  assert.equal(keys.status, 403);
  assert.deepEqual({ error: keys.body.error, what: keys.body.what }, { error: 'plan_limit', what: 'custom_voice_keys' });
  assert.equal((await P({ voice: { cf_app_id: '' } })).status, 200); // clearing is fine
  for (const [m, p] of [['get', '/api/v1/bridge/settings'], ['get', '/api/v1/bridge/platforms'], ['patch', '/api/v1/bridge/settings'], ['put', `/api/v1/bridge/servers/${sid}`]]) {
    const r = await owner.a[m](p, ...(m === 'get' ? [] : [{}]));
    assert.equal(r.status, 403, p);
    assert.deepEqual({ error: r.body.error, what: r.body.what }, { error: 'plan_limit', what: 'bridges' });
  }
});

test('voice quota: admins get it on the gateway, others do not', async () => {
  const adm = await login(104, 'adm'), plain = await login(101, 'one');
  const wa = wsClient(base), wp = wsClient(base);
  clients.push(wa, wp);
  await Promise.all([wa.open(), wp.open()]);
  wa.send({ type: 'auth', session: adm.session }); wp.send({ type: 'auth', session: plain.session });
  await Promise.all([wa.waitFor(f => f.type === 'auth_success'), wp.waitFor(f => f.type === 'auth_success')]);
  require('../src/relay/client').events.emit('voice', { cap_minutes: 3000, used_minutes: 2500 });
  const f = await wa.waitFor(x => x.type === 'instance_update' && x.voice_quota);
  assert.deepEqual(f.voice_quota, { cap_minutes: 3000, used_minutes: 2500 });
  await new Promise(r => setTimeout(r, 150));
  assert.ok(!wp.frames.some(x => x.voice_quota));
});

test('managed.js: plan defaults, bad JSON, and a plain instance has no limits', () => {
  const managed = require('../src/managed');
  const keep = { ...process.env };
  try {
    process.env.BONFIRE_LIMITS = 'not json'; process.env.BONFIRE_PLAN = 'plus';
    assert.deepEqual(managed.limits(), managed.PLAN_DEFAULTS.plus);
    process.env.BONFIRE_LIMITS = JSON.stringify({ member_cap: null, emojis: 7, bridges: 'yes' }); process.env.BONFIRE_PLAN = 'starter';
    assert.deepEqual(managed.limits(), { ...managed.PLAN_DEFAULTS.starter, member_cap: null, emojis: 7 });
    process.env.BONFIRE_PLAN = 'nonsense plan!';
    assert.equal(managed.plan(), 'starter');
    delete process.env.BONFIRE_MANAGED;
    assert.equal(managed.view(), null);
    assert.equal(managed.limit('member_cap'), null);
    assert.equal(managed.allows('bridges'), true);
    managed.assertRoom('emojis', 1e6); managed.assertCanJoin(1e6, false); managed.guardSettings({ accounts_mode: 'local' }, {});
  } finally { for (const k of ['BONFIRE_MANAGED', 'BONFIRE_PLAN', 'BONFIRE_LIMITS']) { if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k]; } }
});
