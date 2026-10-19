'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { unzipSync, strFromU8, zipSync, strToU8 } = require('fflate');
const { startServer } = require('../src/index');
const auth = require('../src/auth');
const db = require('../src/db');
const config = require('../src/config');
const { tmpDir, api, fakeIdp } = require('./helpers');
process.env.BONFIRE_ACCOUNTS_MODE = 'velora';
process.env.BONFIRE_PUBLIC_URL = 'http://chat.test';
process.env.BONFIRE_VELORA_URL = 'http://velora.test';
process.env.BONFIRE_OWNER = 'v:100';
delete process.env.BONFIRE_MANAGED;
delete process.env.BONFIRE_READ_ONLY;
const dir = tmpDir(), idp = fakeIdp({ iss: 'http://velora.test', aud: 'http://chat.test' });
let inst, owner, member, admin, sid, role;
const B = '/api/v1/instance/backups';
const file = buf => { const f = new FormData(); f.append('file', new Blob([buf]), 'export.zip'); return f; };
const S = p => `/api/v1/servers/${sid}${p || ''}`;
const login = async sub => { const r = await api(inst.url).post('/api/v1/auth/velora', { token: idp.mint({ sub: String(sub), username: 'user' + sub }) }); assert.equal(r.status, 200); return api(inst.url, r.body.session); };
test.before(async () => {
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1' });
  auth.setJwksFetcher(idp.jwks);
  owner = await login(100); member = await login(101); admin = await login(102);
});
test.after(async () => { delete process.env.BONFIRE_MANAGED; delete process.env.BONFIRE_LIMITS; delete process.env.BONFIRE_READ_ONLY; await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });
test('backups: no community, admin access, and owner-only restore', async () => {
  assert.equal((await owner.post(B)).body.error, 'no_community');
  sid = (await owner.post('/api/v1/servers', { name: 'Backup test', join_policy: 'open' })).body.server.sid;
  await member.post(S('/join')); await admin.post(S('/join'));
  await owner.put('/api/v1/instance/admins/v:102');
  for (const r of [await member.get(B), await member.post(B), await member.del(B + '/abcd'), await member.get(B + '/abcd/download')]) assert.equal(r.status, 403);
  assert.equal((await admin.get(B)).status, 200);
  assert.equal((await admin.post(B + '/abcd/restore')).status, 403);
  assert.equal((await admin.raw('POST', '/api/v1/instance/restore', file(Buffer.from('bad')))).status, 403);
});
test('roles: nullable 1-500 override, 20 MB upload allowed only with role, owner ceiling and plan cap', async () => {
  await owner.patch('/api/v1/instance/settings', { max_upload_mb: 500 });
  const patched = (await owner.patch(S(), { upload_max_mb: 10 })).body.server;
  assert.equal(patched.upload_max_mb, 10);
  assert.equal(patched.my_upload_max_mb, 500);
  assert.equal(patched.upload_ceiling_mb, 500);
  const r = await owner.post(S('/roles'), { name: 'Large files', upload_max_mb: 250 });
  assert.equal(r.status, 200); role = r.body.role;
  assert.equal(role.upload_max_mb, 250);
  for (const v of [0, 501, 1.5, '250', false]) assert.equal((await owner.patch(S('/roles/' + role.rid), { upload_max_mb: v })).status, 400);
  {
    const server = (await member.get(S())).body.server;
    assert.equal(server.upload_max_mb, 10);
    assert.equal(server.my_upload_max_mb, 10);
    assert.equal(server.upload_ceiling_mb, config.get().max_upload_mb);
  }
  const ownerServer = (await owner.get(S())).body.server;
  assert.equal(ownerServer.upload_max_mb, 10);
  assert.equal(ownerServer.my_upload_max_mb, 500);
  assert.equal(ownerServer.upload_ceiling_mb, 500);
  const data = Buffer.alloc(20 * 1024 * 1024, 1);
  const denied = await member.raw('POST', '/api/v1/media/upload?sid=' + sid, file(data));
  assert.equal(denied.status, 413); assert.equal(denied.body.max_mb, 10);
  await owner.put(S('/members/v:101/roles/' + role.rid));
  {
    const server = (await member.get(S())).body.server;
    assert.equal(server.upload_max_mb, 10);
    assert.equal(server.my_upload_max_mb, 250);
    assert.equal(server.upload_ceiling_mb, 500);
  }
  assert.equal((await member.raw('POST', '/api/v1/media/upload?sid=' + sid, file(data))).status, 200);
  process.env.BONFIRE_MANAGED = '1'; process.env.BONFIRE_PLAN = 'starter'; process.env.BONFIRE_LIMITS = JSON.stringify({ max_upload_mb: 10 });
  {
    const server = (await member.get(S())).body.server;
    assert.equal(server.upload_max_mb, 10);
    assert.equal(server.my_upload_max_mb, 10);
    assert.equal(server.upload_ceiling_mb, config.get().max_upload_mb);
  }
  assert.equal((await member.raw('POST', '/api/v1/media/upload?sid=' + sid, file(data))).status, 413);
  process.env.BONFIRE_PLAN = 'plus'; delete process.env.BONFIRE_LIMITS;
  assert.equal(config.get().max_upload_mb, 250);
  const plusServer = (await member.get(S())).body.server;
  assert.equal(plusServer.upload_max_mb, 10);
  assert.equal(plusServer.my_upload_max_mb, 250);
  assert.equal(plusServer.upload_ceiling_mb, 250);
  const listed = (await member.get('/api/v1/servers')).body.servers.find(s => s.sid === sid);
  assert.equal(listed.upload_max_mb, 10);
  assert.equal(listed.my_upload_max_mb, 250);
  assert.equal(listed.upload_ceiling_mb, 250);
  delete process.env.BONFIRE_MANAGED;
  assert.equal((await owner.patch(S('/roles/' + role.rid), { upload_max_mb: null })).body.role.upload_max_mb, null);
  await owner.patch(S('/roles/' + role.rid), { upload_max_mb: 250 });
});
test('backups: create/list/download ZIP, restore a deleted channel and role override, safety copy', async () => {
  await owner.post(S('/channels'), { name: 'keep-me' });
  const made = await admin.post(B, { note: 'checkpoint' });
  assert.equal(made.status, 200); const b = made.body.backup;
  assert.equal(b.by, 'v:102'); assert.equal(b.note, 'checkpoint');
  assert.equal((await admin.get(B)).body.backups[0].id, b.id);
  const zip = await admin.get(B + '/' + b.id + '/download');
  assert.equal(zip.status, 200); assert.match(zip.headers.get('content-disposition'), /attachment/);
  const entries = unzipSync(zip.body);
  assert.equal(JSON.parse(strFromU8(entries['manifest.json'])).format, 'bonfire-export-v1');
  assert.equal(JSON.parse(strFromU8(entries['community.json'])).roles.find(r => r.name === 'Large files').upload_max_mb, 250);
  const ch = (await owner.get(S())).body.channels.find(c => c.name === 'keep-me');
  await owner.del('/api/v1/channels/' + ch.cid);
  const restored = await owner.post(B + '/' + b.id + '/restore');
  assert.equal(restored.status, 200, JSON.stringify(restored.body)); sid = restored.body.sid;
  const detail = (await owner.get(S())).body;
  assert.ok(detail.channels.some(c => c.name === 'keep-me'));
  assert.equal(detail.roles.find(r => r.name === 'Large files').upload_max_mb, 250);
  assert.equal((await owner.get(B)).body.backups[0].note, 'before restore');
  {
    const server = (await member.get(S())).body.server;
    assert.equal(server.upload_max_mb, 10);
    assert.equal(server.my_upload_max_mb, 250);
    assert.equal(server.upload_ceiling_mb, 500);
  }
  // Multipart restore accepts older exports whose roles lack the new field.
  const cj = JSON.parse(strFromU8(entries['community.json']));
  cj.roles.forEach(r => delete r.upload_max_mb); entries['community.json'] = strToU8(JSON.stringify(cj));
  const uploaded = await owner.raw('POST', '/api/v1/instance/restore', file(zipSync(entries)));
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body)); sid = uploaded.body.sid;
  assert.ok((await owner.get(S())).body.roles.every(r => r.upload_max_mb === null));
});
test('restore rejects malformed archives and rolls back a failed import', async () => {
  assert.equal((await owner.raw('POST', '/api/v1/instance/restore', file(Buffer.from('bad')))).body.error, 'invalid_export');
  const zip = (await owner.get(S('/export'))).body, entries = unzipSync(zip);
  const cj = JSON.parse(strFromU8(entries['community.json'])); cj.name = ''; entries['community.json'] = strToU8(JSON.stringify(cj));
  const bad = await owner.raw('POST', '/api/v1/instance/restore', file(zipSync(entries)));
  assert.equal(bad.status, 400); assert.equal(bad.body.error, 'name_required');
  assert.equal((await owner.get(S())).status, 200);
  assert.ok((await owner.get(S())).body.channels.some(c => c.name === 'keep-me'));
});
test('max_backups pruning, selected restore with max=1, deletion, read-only list/download', async () => {
  assert.equal((await owner.patch('/api/v1/instance/settings', { max_backups: 0 })).status, 400);
  await owner.patch('/api/v1/instance/settings', { max_backups: 2 });
  for (let i = 0; i < 4; i++) assert.equal((await owner.post(B)).status, 200);
  let list = (await owner.get(B)).body.backups;
  assert.equal(list.length, 2); assert.equal(fs.readdirSync(dir + '/backups').filter(f => f.endsWith('.zip')).length, 2);
  await owner.patch('/api/v1/instance/settings', { max_backups: 1 });
  list = (await owner.get(B)).body.backups; assert.equal(list.length, 1);
  const restored = await owner.post(B + '/' + list[0].id + '/restore'); assert.equal(restored.status, 200); sid = restored.body.sid;
  const b = (await owner.get(B)).body.backups[0]; assert.equal(b.note, 'before restore');
  process.env.BONFIRE_READ_ONLY = '1';
  assert.equal((await admin.get(B)).status, 200); assert.equal((await admin.get(B + '/' + b.id + '/download')).status, 200);
  for (const r of [await owner.post(B), await owner.del(B + '/' + b.id), await owner.post(B + '/' + b.id + '/restore'), await owner.post('/api/v1/instance/restore')]) { assert.equal(r.status, 403); assert.equal(r.body.error, 'read_only'); }
  delete process.env.BONFIRE_READ_ONLY;
  assert.equal((await admin.del(B + '/' + b.id)).status, 200);
  assert.equal((await owner.get(B)).body.backups.length, 0);
  assert.equal((await owner.get(B + '/../../config.json/download')).status, 404);
});
