'use strict';
// Switching an instance from Velora accounts to local accounts needs an admin who can sign in with a password (or you'd be
// locked out): PATCH accounts_mode 'local' is refused until there is one, and the owner can make one first.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tmpDir, api, fakeIdp } = require('./helpers');

delete process.env.BONFIRE_ACCOUNTS_MODE;
process.env.BONFIRE_VELORA_URL = 'http://velora.test/';
process.env.BONFIRE_PUBLIC_URL = 'https://chat.test';
process.env.BONFIRE_OWNER = 'v:123';
const { startServer } = require('../src/index');
const auth = require('../src/auth');
const config = require('../src/config');

const idp = fakeIdp();
const dir = tmpDir();
fs.writeFileSync(dir + '/config.json', JSON.stringify({ accounts_mode: 'velora' }));
let inst;
test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1' }); auth.setJwksFetcher(idp.jwks); });
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

test('switching to local accounts needs a local admin; the owner can make one with an admin role', async () => {
  const owner = api(inst.url, (await api(inst.url).post('/api/v1/auth/velora', { token: idp.mint() })).body.session);
  const sid = (await owner.post('/api/v1/servers', { name: 'Camp' })).body.server.sid;
  assert.equal(config.get().accounts_mode, 'velora');
  assert.equal((await owner.patch('/api/v1/instance/settings', { accounts_mode: 'local' })).body.error, 'local_admin_required');
  assert.deepEqual((await owner.get('/api/v1/instance/settings')).body.local_admins, []);
  const r = await owner.post('/api/v1/instance/local-admin', { username: 'backup', password: 'correct horse battery' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.settings.local_admins, ['backup']);
  const me = (await owner.get(`/api/v1/servers/${sid}/members`)).body.members.find(m => m.username === 'backup');
  const roles = (await owner.get(`/api/v1/servers/${sid}`)).body.roles;
  assert.ok(me.roles.some(rid => Number(roles.find(x => x.rid === rid).permissions) & 512), 'has an Administrator role');
  assert.equal((await owner.patch('/api/v1/instance/settings', { accounts_mode: 'local' })).status, 200);
  assert.equal(config.get().accounts_mode, 'local');
});
