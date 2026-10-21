'use strict';
// GET/POST /api/v1/instance/update: one-click self-update through bonfire-hostd (here: a fake hostd HTTP server).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const { startServer } = require('../src/index');
const auth = require('../src/auth');
const { tmpDir, api, fakeIdp } = require('./helpers');
process.env.BONFIRE_ACCOUNTS_MODE = 'velora';
process.env.BONFIRE_PUBLIC_URL = 'http://chat.test';
process.env.BONFIRE_VELORA_URL = 'http://velora.test';
process.env.BONFIRE_OWNER = 'v:100';
delete process.env.BONFIRE_MANAGED;
delete process.env.BONFIRE_UPDATE_URL;
delete process.env.BONFIRE_UPDATE_SECRET;
const dir = tmpDir(), idp = fakeIdp({ iss: 'http://velora.test', aud: 'http://chat.test' });
const SECRET = 'very-secret-update-token-0123456789';
const U = '/api/v1/instance/update';
let inst, owner, member, fake, fakeUrl;
const hits = [];
let reply = { status: 200, body: {} };
const login = async sub => { const r = await api(inst.url).post('/api/v1/auth/velora', { token: idp.mint({ sub: String(sub), username: 'user' + sub }) }); assert.equal(r.status, 200); return api(inst.url, r.body.session); };
const configure = () => { process.env.BONFIRE_UPDATE_URL = fakeUrl + '/'; process.env.BONFIRE_UPDATE_SECRET = SECRET; };
const unconfigure = () => { delete process.env.BONFIRE_UPDATE_URL; delete process.env.BONFIRE_UPDATE_SECRET; };

test.before(async () => {
  fake = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${fake.address().port}`;
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1' });
  auth.setJwksFetcher(idp.jwks);
  owner = await login(100); member = await login(101);
  const sid = (await owner.post('/api/v1/servers', { name: 'Update test', join_policy: 'open' })).body.server.sid;
  await member.post(`/api/v1/servers/${sid}/join`);
});
test.after(async () => { unconfigure(); delete process.env.BONFIRE_MANAGED; await inst.close(); await new Promise(r => fake.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

test('update: admins only', async () => {
  configure();
  assert.equal((await member.get(U)).status, 403);
  assert.equal((await member.post(U)).status, 403);
  assert.equal((await api(inst.url).get(U)).status, 401);
  assert.equal((await api(inst.url).post(U)).status, 401);
  assert.equal(hits.length, 0, 'nothing reached hostd');
  unconfigure();
});

test('update: not configured -> supported:false and 501 update_not_supported', async () => {
  const g = await owner.get(U);
  assert.equal(g.status, 200); assert.equal(g.body.supported, false); assert.equal(g.body.reason, 'not_configured');
  assert.equal(g.body.current.version, require('../package.json').version);
  const p = await owner.post(U);
  assert.equal(p.status, 501); assert.equal(p.body.error, 'update_not_supported');
  process.env.BONFIRE_UPDATE_URL = fakeUrl; // a URL without a secret is still not configured
  assert.equal((await owner.get(U)).body.supported, false);
  process.env.BONFIRE_UPDATE_URL = 'not a url'; process.env.BONFIRE_UPDATE_SECRET = SECRET;
  assert.equal((await owner.post(U)).status, 501);
  unconfigure();
  assert.equal(hits.length, 0);
});

test('update: managed (Velora-hosted) instances are not self-updated', async () => {
  configure(); process.env.BONFIRE_MANAGED = '1';
  try {
    const g = await owner.get(U);
    assert.equal(g.body.supported, false); assert.equal(g.body.reason, 'managed');
    const p = await owner.post(U);
    assert.equal(p.status, 501); assert.equal(p.body.error, 'update_managed');
  } finally { delete process.env.BONFIRE_MANAGED; unconfigure(); }
  assert.equal(hits.length, 0);
});

test('update: GET asks hostd for the latest build, POST starts the update; the secret is only sent to hostd', async () => {
  configure();
  const seen = [];
  reply = { status: 200, body: { container: 'bonfire-chat', image_current: false, outdated: true, running: { commit: 'a'.repeat(40), commit_short: 'aaaaaaa', build_id: 'a'.repeat(40) }, latest: { version: '0.2.0', commit: 'b'.repeat(40), commit_short: 'bbbbbbb', build_id: 'b'.repeat(40), commit_date: '2026-10-20T00:00:00Z', message: 'new stuff', evil: 'dropped' }, update: { state: 'idle', output: 'tail', secret: 'dropped' } } };
  const g = await owner.get(U); seen.push(g);
  assert.equal(g.status, 200); assert.equal(g.body.supported, true); assert.equal(g.body.reachable, true); assert.equal(g.body.outdated, true);
  assert.equal(g.body.latest.commit_short, 'bbbbbbb'); assert.equal(g.body.latest.message, 'new stuff'); assert.equal(g.body.latest.evil, undefined);
  assert.equal(g.body.running.commit_short, 'aaaaaaa'); assert.equal(g.body.update.state, 'idle'); assert.equal(g.body.update.secret, undefined);
  assert.deepEqual(hits.at(-1), { method: 'GET', url: '/chat-update', auth: 'Bearer ' + SECRET });
  reply = { status: 202, body: { ok: true, update: { state: 'running', step: 'queued', started_at: '2026-10-20T00:00:00.000Z' } } };
  const p = await owner.post(U); seen.push(p);
  assert.equal(p.status, 200); assert.equal(p.body.ok, true); assert.equal(p.body.update.state, 'running');
  assert.deepEqual(hits.at(-1), { method: 'POST', url: '/chat-update', auth: 'Bearer ' + SECRET });
  for (const r of seen) assert.ok(!JSON.stringify(r.body).includes(SECRET) && !JSON.stringify(r.body).includes(fakeUrl), 'no secret / hostd address in the answer');
  unconfigure();
});

test('update: hostd failures become stable errors', async () => {
  configure();
  try {
    reply = { status: 409, body: { error: 'update_in_progress' } };
    let p = await owner.post(U); assert.equal(p.status, 409); assert.equal(p.body.error, 'update_in_progress');
    reply = { status: 401, body: { error: 'unauthorized' } };
    p = await owner.post(U); assert.equal(p.status, 502); assert.equal(p.body.error, 'update_service_rejected');
    const g = await owner.get(U); assert.equal(g.status, 200); assert.equal(g.body.supported, true); assert.equal(g.body.reachable, false); assert.equal(g.body.error, 'update_service_rejected');
    reply = { status: 500, body: { error: 'server_error', detail: SECRET } };
    p = await owner.post(U); assert.equal(p.status, 502); assert.equal(p.body.error, 'update_service_error'); assert.ok(!JSON.stringify(p.body).includes(SECRET));
    // hostd not listening
    const port = fake.address().port;
    await new Promise(r => fake.close(r));
    p = await owner.post(U); assert.equal(p.status, 502); assert.equal(p.body.error, 'update_service_unreachable');
    const g2 = await owner.get(U); assert.equal(g2.body.reachable, false); assert.equal(g2.body.error, 'update_service_unreachable');
    await new Promise(r => fake.listen(port, '127.0.0.1', r));
  } finally { unconfigure(); }
});
