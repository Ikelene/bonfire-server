'use strict';
// Velora instance-JWT verification + login (velora mode), BONFIRE_OWNER pre-claim.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const { tmpDir, api, fakeIdp } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'velora';
process.env.BONFIRE_VELORA_URL = 'http://velora.test/';
process.env.BONFIRE_PUBLIC_URL = 'HTTPS://Chat.Test:443/some/path';
process.env.BONFIRE_OWNER = 'v:123';
const { startServer } = require('../src/index');
const auth = require('../src/auth');

const idp = fakeIdp();
const dir = tmpDir();
let inst;
test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1' }); auth.setJwksFetcher(idp.jwks); });
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const code = async p => { try { await p; return null; } catch (e) { return e.code; } };

test('a good token verifies (claims returned)', async () => {
  const c = await auth.verifyVeloraJwt(idp.mint());
  assert.equal(c.sub, '123');
  assert.equal(c.username, 'nat');
});
test('wrong audience / wrong issuer are refused (origins are normalized before comparing)', async () => {
  assert.equal(await code(auth.verifyVeloraJwt(idp.mint({ aud: 'https://other.example' }))), 'invalid_audience');
  assert.equal(await code(auth.verifyVeloraJwt(idp.mint({ iss: 'https://evil.example' }))), 'invalid_issuer');
  // same origin spelled differently still matches
  assert.equal((await auth.verifyVeloraJwt(idp.mint({ aud: 'https://CHAT.test:443/', iss: 'HTTP://velora.test:80' }))).sub, '123');
});
test('expired tokens are refused, with 60 s of skew allowed', async () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(await code(auth.verifyVeloraJwt(idp.mint({ iat: now - 700, exp: now - 100 }))), 'token_expired');
  assert.equal((await auth.verifyVeloraJwt(idp.mint({ iat: now - 700, exp: now - 30 }))).sub, '123');
});
test('a jti can only be used once', async () => {
  const t = idp.mint({ jti: 'replay-me' });
  await auth.verifyVeloraJwt(t);
  assert.equal(await code(auth.verifyVeloraJwt(t)), 'token_replayed');
});
test('unknown kid triggers one JWKS refetch, then fails', async () => {
  const other = crypto.generateKeyPairSync('ed25519');
  const before = idp.jwksFetches;
  assert.equal(await code(auth.verifyVeloraJwt(idp.mint({}, { key: other.privateKey, kid: 'ghost' }))), 'unknown_kid');
  assert.ok(idp.jwksFetches - before <= 1);
});
test('forged signature, wrong algorithm, junk are refused', async () => {
  const other = crypto.generateKeyPairSync('ed25519');
  assert.equal(await code(auth.verifyVeloraJwt(idp.mint({}, { key: other.privateKey }))), 'invalid_signature');
  const parts = idp.mint().split('.');
  const tampered = [parts[0], Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], 'base64url')), sub: '1' })).toString('base64url'), parts[2]].join('.');
  assert.equal(await code(auth.verifyVeloraJwt(tampered)), 'invalid_signature');
  assert.equal(await code(auth.verifyVeloraJwt(idp.mint({}, { alg: 'HS256' }))), 'invalid_token');
  assert.equal(await code(auth.verifyVeloraJwt('a.b')), 'invalid_token');
});

test('POST /auth/velora: login, principal user, scopes, profile refresh', async () => {
  const a = api(inst.url);
  const r = await a.post('/api/v1/auth/velora', { token: idp.mint({ sub: '555', username: 'nat', scp: ['chat', 'media'] }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.user, { id: 'v:555', kind: 'velora', username: 'nat', display_name: 'nat', pfp: null, velora_id: '555' });
  const me = await api(inst.url, r.body.session).get('/api/v1/me');
  assert.deepEqual(me.body.scopes, ['chat', 'media']);
  const again = await a.post('/api/v1/auth/velora', { token: idp.mint({ sub: '555', username: 'nat2', display_name: 'Nat Two', pfp: 'https://velora.test/p.png', scp: ['chat'] }) });
  assert.equal(again.body.user.username, 'nat2');
  assert.equal(again.body.user.pfp, 'https://velora.test/p.png');
  const no = await a.post('/api/v1/auth/velora', { token: idp.mint({ sub: '556', scp: ['voice'] }) });
  assert.equal(no.status, 403);
  assert.equal(no.body.error, 'insufficient_scope');
  const bad = await a.post('/api/v1/auth/velora', { token: idp.mint({ aud: 'https://x.example' }) });
  assert.equal(bad.status, 401);
  assert.equal((await a.post('/api/v1/auth/register', { username: 'abc', password: 'password123' })).body.error, 'wrong_accounts_mode');
});

test('BONFIRE_OWNER pre-claims the instance; discovery shows the velora block', async () => {
  const wk = (await api(inst.url).get('/.well-known/bonfire')).body;
  assert.equal(wk.accounts_mode, 'velora');
  assert.equal(wk.claimed, true);
  assert.equal(wk.public_url, 'https://chat.test');
  assert.deepEqual(wk.velora, { issuer: 'http://velora.test', jwks_url: 'http://velora.test/.well-known/bonfire/jwks.json' });
  assert.equal(wk.features.signing, true);
  assert.equal(inst.setup.current(), null);
  const r = await api(inst.url).post('/api/v1/auth/velora', { token: idp.mint({ sub: '123', username: 'owner' }) });
  const me = await api(inst.url, r.body.session).get('/api/v1/me');
  assert.equal(me.body.instance_owner, true);
  assert.equal(me.body.instance_admin, true);
});

test('local password hashing: scrypt, per-user salt, constant verify', async () => {
  const h1 = await auth.hashPassword('hunter2hunter2'), h2 = await auth.hashPassword('hunter2hunter2');
  assert.notEqual(h1, h2);
  assert.match(h1, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(await auth.checkPassword('hunter2hunter2', h1), true);
  assert.equal(await auth.checkPassword('hunter3hunter3', h1), false);
});
