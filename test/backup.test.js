'use strict';
// Backups and read-only mode of Velora-hosted servers (PROTOCOL §19.5 / §19.6): src/cli.js export, BONFIRE_IMPORT_ON_BOOT, BONFIRE_READ_ONLY.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { unzipSync, strFromU8 } = require('fflate');
const { startServer } = require('../src/index');
const auth = require('../src/auth');
const { tmpDir, api, wsClient, fakeIdp } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'velora';
process.env.BONFIRE_VELORA_URL = 'http://velora.test/';
process.env.BONFIRE_PUBLIC_URL = 'http://chat.test';
process.env.BONFIRE_OWNER = 'v:100';
delete process.env.BONFIRE_MANAGED;
delete process.env.BONFIRE_READ_ONLY;
delete process.env.BONFIRE_IMPORT_ON_BOOT;

const idp = fakeIdp({ iss: 'http://velora.test', aud: 'http://chat.test' });
const dirA = tmpDir(), dirB = tmpDir(), zipPath = path.join(tmpDir(), 'backup.zip');
const login = async (base, sub, username) => {
  const r = await api(base).post('/api/v1/auth/velora', { token: idp.mint({ sub: String(sub), username }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...r.body, a: api(base, r.body.session) };
};
const cli = (dir, ...args) => spawnSync(process.execPath, [path.join(__dirname, '../src/cli.js'), ...args], { env: { ...process.env, BONFIRE_DATA: dir }, encoding: 'utf8' });

test('cli export: nothing to back up on an empty instance, a bonfire-export-v1 zip otherwise', async () => {
  const inst = await startServer({ dataDir: dirA, port: 0, host: '127.0.0.1', restart: () => {} });
  auth.setJwksFetcher(idp.jwks);
  const owner = await login(inst.url, 100, 'owner');
  await inst.close();
  assert.equal(cli(dirA, 'export', zipPath).status, 3, 'no community yet');
  assert.equal(cli(dirA).status, 2, 'usage');
  // build a community, then back it up with the instance stopped
  const inst2 = await startServer({ dataDir: dirA, port: 0, host: '127.0.0.1', restart: () => {} });
  const o2 = await login(inst2.url, 100, 'owner');
  const d = (await o2.a.post('/api/v1/servers', { name: 'Backed Up', join_policy: 'open' })).body;
  const ch = d.channels.find(c => c.type === 'text').cid;
  assert.equal((await o2.a.post(`/api/v1/channels/${ch}/messages`, { message: 'remember me' })).status, 200);
  // the export also works while the instance is running (SQLite WAL), which is how the host takes it
  const run = cli(dirA, 'export', zipPath);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(JSON.parse(run.stdout).size > 100);
  await inst2.close();
  const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
  assert.equal(JSON.parse(strFromU8(files['manifest.json'])).format, 'bonfire-export-v1');
  assert.ok(Object.values(files).some(f => strFromU8(f).includes('remember me')));
  void owner;
});

test('BONFIRE_IMPORT_ON_BOOT restores the backup once, for the owner, then removes the file', async () => {
  process.env.BONFIRE_IMPORT_ON_BOOT = zipPath;
  const inst = await startServer({ dataDir: dirB, port: 0, host: '127.0.0.1', restart: () => {} });
  delete process.env.BONFIRE_IMPORT_ON_BOOT;
  auth.setJwksFetcher(idp.jwks);
  const owner = await login(inst.url, 100, 'owner');
  assert.ok(!fs.existsSync(zipPath), 'the zip is deleted after the import');
  const servers = (await owner.a.get('/api/v1/servers')).body.servers;
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, 'Backed Up');
  const sid = servers[0].sid;
  const detail = (await owner.a.get(`/api/v1/servers/${sid}`)).body;
  const ch = detail.channels.find(c => c.type === 'text').cid;
  const msgs = (await owner.a.get(`/api/v1/channels/${ch}/messages`)).body.messages;
  assert.ok(msgs.some(m => m.body === 'remember me'));
  assert.equal((await api(inst.url).get('/.well-known/bonfire')).body.community.name, 'Backed Up');

  // read-only mode: reading, signing in and the export work; every write is refused
  process.env.BONFIRE_READ_ONLY = '1';
  try {
    const wk = (await api(inst.url).get('/.well-known/bonfire')).body;
    assert.equal(wk.read_only, true);
    assert.equal((await owner.a.get(`/api/v1/servers/${sid}`)).body.server.read_only, true);
    assert.equal((await owner.a.get(`/api/v1/channels/${ch}/messages`)).status, 200);
    assert.equal((await owner.a.raw('GET', `/api/v1/servers/${sid}/export`)).status, 200);
    assert.equal((await login(inst.url, 100, 'owner')).a ? 200 : 0, 200); // signing in still works
    const writes = [
      owner.a.post(`/api/v1/channels/${ch}/messages`, { message: 'nope' }),
      owner.a.patch(`/api/v1/servers/${sid}`, { name: 'Changed' }),
      owner.a.patch('/api/v1/instance/settings', { name: 'Changed' }),
      owner.a.post(`/api/v1/servers/${sid}/channels`, { name: 'extra' }),
      owner.a.post(`/api/v1/servers/${sid}/invites`, {}),
      owner.a.post('/api/v1/bots', { name: 'abc' }),
      owner.a.put(`/api/v1/messages/1/reactions/${encodeURIComponent('x')}`),
    ];
    for (const r of await Promise.all(writes)) { assert.equal(r.status, 403); assert.equal(r.body.error, 'read_only'); }
    // a message posted any other way (gateway frame) is refused too
    const w = wsClient(inst.url);
    await w.login(owner.session);
    w.send({ type: 'chat_send', channel: ch, message: 'nope', nonce: 'n1' });
    assert.equal((await w.waitFor(f => f.type === 'chat_error' && f.nonce === 'n1')).error, 'read_only');
    w.send({ type: 'chat_rtc_join', room: 'bf_' + ch, nonce: 'n2' });
    assert.equal((await w.waitFor(f => f.type === 'chat_error' && f.nonce === 'n2')).error, 'read_only');
    w.close();
  } finally { delete process.env.BONFIRE_READ_ONLY; }
  // paying brings it back
  assert.equal((await owner.a.post(`/api/v1/channels/${ch}/messages`, { message: 'back' })).status, 200);
  await inst.close();
});

test.after(() => { for (const d of [dirA, dirB, path.dirname(zipPath)]) fs.rmSync(d, { recursive: true, force: true }); });
