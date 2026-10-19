'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tmpDir, api, wsClient, fakeIdp } = require('./helpers');
const { startServer } = require('../src/index');
const auth = require('../src/auth');
const db = require('../src/db');
const C = require('../src/communities');
const M = require('../src/messages');
const unfurl = require('../src/unfurl');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const file = () => { const f = new FormData(); f.append('file', new Blob([PNG]), 'pixel.png'); return f; };

for (const mode of ['local', 'velora']) test(`${mode}: ordinary member uploads, remote imports and stable custom reactions`, async t => {
  process.env.BONFIRE_ACCOUNTS_MODE = mode;
  process.env.BONFIRE_VELORA_URL = 'http://velora.test';
  process.env.BONFIRE_PUBLIC_URL = 'https://chat.test';
  delete process.env.BONFIRE_OWNER;
  const dir = tmpDir(), inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1' });
  let socket;
  t.after(async () => { socket?.close(); await inst.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const idp = fakeIdp(); auth.setJwksFetcher(idp.jwks);
  async function login(username, sub, scp) {
    const r = mode === 'local'
      ? await api(inst.url).post('/api/v1/auth/register', { username, password: 'correct horse battery' })
      : await api(inst.url).post('/api/v1/auth/velora', { token: idp.mint({ username, sub, ...(scp ? { scp } : {}) }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { ...r.body, a: api(inst.url, r.body.session) };
  }
  const owner = await login('owner', '100'), member = await login('member', '101');
  assert.equal((await owner.a.post('/api/v1/instance/claim', { code: inst.setup.current() })).status, 200);
  const setup = await owner.a.post('/api/v1/servers', { name: 'Camp', join_policy: 'open' });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  const sid = setup.body.server.sid, cid = setup.body.channels.find(c => c.type === 'text').cid;
  const S = `/api/v1/servers/${sid}`;
  assert.equal((await member.a.post(S + '/join')).status, 200);
  const detail = (await member.a.get(S)).body, everyone = detail.roles.find(r => r.is_default);
  assert.equal(everyone.permissions, 257);
  assert.ok(detail.roles.every(r => r.upload_max_mb === null));
  assert.equal(detail.server.my_upload_max_mb, 25); // no config override, no extra role
  const uploadPath = `/api/v1/media/upload?sid=${sid}&cid=${cid}`;
  const up = await member.a.raw('POST', uploadPath, file());
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.match(up.body.sha256, /^[a-f0-9]{64}$/);
  const post = async (attachments, body = '') => { M._sendLimit.reset(); return member.a.post(`/api/v1/channels/${cid}/messages`, { message: body, attachments }); };
  assert.equal((await post([up.body])).status, 200);
  const override = overwrites => owner.a.put(`/api/v1/channels/${cid}/perms`, { overwrites });
  await override([{ rid: everyone.rid, deny: 256, allow: 0 }]);
  assert.equal((await member.a.raw('POST', uploadPath, file())).body.error, 'no_attach_permission');
  assert.equal((await post([up.body])).body.error, 'no_attach_permission');
  const role = (await owner.a.post(S + '/roles', { name: 'image perms', permissions: 0 })).body.role;
  await owner.a.put(S + `/members/${encodeURIComponent(member.user.id)}/roles/${role.rid}`);
  await override([{ rid: everyone.rid, deny: 256, allow: 0 }, { rid: role.rid, allow: 256, deny: 0 }]);
  assert.equal((await member.a.raw('POST', uploadPath, file())).status, 200);
  // Channel grants must also work when ATTACH is absent from base permissions.
  await owner.a.patch(S + '/roles/' + everyone.rid, { permissions: 1 });
  assert.equal((await member.a.raw('POST', uploadPath, file())).status, 200);
  assert.equal((await post([up.body])).status, 200);
  await owner.a.patch(S + '/roles/' + everyone.rid, { permissions: 257 });
  await override([]);
  const c = C.findCommunity(sid), snap = C.snapOf(c), user = auth.userByPrincipal(member.user.id);
  assert.equal(C.effectiveUploadMax({ ...c, upload_max_mb: null }, snap, user), 25);
  assert.equal(C.effectiveUploadMax({ ...c, upload_max_mb: 0 }, snap, user), 25);
  await owner.a.patch(S, { upload_max_mb: 1 });
  const large = new FormData(); large.append('file', new Blob([Buffer.alloc(1024 * 1024 + 1)]), 'large.bin');
  assert.equal((await member.a.raw('POST', uploadPath, large)).status, 413);
  await owner.a.patch(S, { upload_max_mb: 25 });

  const importPath = `/api/v1/media/import?sid=${sid}&cid=${cid}`;
  await override([{ rid: everyone.rid, deny: 256, allow: 0 }]);
  assert.equal((await member.a.post(importPath, { url: 'https://cdn.example/media.png' })).body.error, 'no_attach_permission');
  await override([]);
  for (const url of ['file:///etc/passwd', 'http://example.com/file', 'https://user:pass@example.com/file']) {
    assert.equal((await member.a.post(importPath, { url })).body.error, 'invalid_media_url');
  }
  assert.equal((await member.a.post(importPath, { url: 'https://127.0.0.1/private' })).body.error, 'media_import_failed');
  const realFetch = unfurl.fetchSafe;
  t.after(() => { unfurl.fetchSafe = realFetch; });
  // Remote server sends no CORS headers. Only the instance downloads it.
  unfurl.fetchSafe = async (url, options) => {
    assert.equal(url, 'https://cdn.example/media.png');
    assert.equal(options.maxBytes, 25 * 1024 * 1024);
    return { status: 200, body: PNG, cut: false, headers: {} };
  };
  const imported = await member.a.post(importPath, { url: 'https://cdn.example/media.png', name: 'saved.png' });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.type, 'image');
  assert.equal(imported.body.sha256, up.body.sha256);
  assert.equal((await post([imported.body])).status, 200);
  unfurl.fetchSafe = async () => ({ status: 200, body: PNG, cut: true });
  const oversized = await member.a.post(importPath, { url: 'https://cdn.example/huge' });
  assert.equal(oversized.status, 413); assert.equal(oversized.body.max_mb, 25);
  unfurl.fetchSafe = realFetch;
  await owner.a.patch(S, { allow_uploads: false });
  assert.equal((await member.a.raw('POST', uploadPath, file())).body.error, 'uploads_disabled');
  assert.equal((await member.a.post(importPath, { url: 'https://cdn.example/media.png' })).body.error, 'uploads_disabled');
  await owner.a.patch(S, { allow_uploads: true });
  if (mode === 'velora') {
    const limited = await login('limited', '102', ['chat']); await limited.a.post(S + '/join');
    assert.equal((await limited.a.raw('POST', uploadPath, file())).body.error, 'insufficient_scope');
    assert.equal((await limited.a.post(importPath, { url: 'https://cdn.example/media.png' })).body.error, 'insufficient_scope');
  }

  const message = (await post([], 'react here')).body.message;
  const emojiFile = file(); emojiFile.append('name', 'pixel');
  const emojiResponse = await owner.a.raw('POST', S + '/emojis', emojiFile);
  assert.equal(emojiResponse.status, 200, JSON.stringify(emojiResponse.body));
  const emoji = emojiResponse.body.emoji, key = 'c:' + emoji.eid;
  const reactionPath = `/api/v1/messages/${message.id}/reactions/`;
  socket = await wsClient(inst.url).login(member.session);
  assert.equal((await member.a.put(reactionPath + encodeURIComponent(key))).status, 200);
  const event = await socket.waitFor(f => f.type === 'chat_reactions' && f.id === message.id);
  assert.equal(event.emoji, key); assert.equal(event.reactions[0].url, emoji.url); assert.equal(event.reactions[0].name, 'pixel');
  const reactions = async () => (await member.a.get(`/api/v1/channels/${cid}/messages`)).body.messages.find(m => m.id === message.id).reactions || [];
  await owner.a.put(reactionPath + encodeURIComponent(':pixel:'));
  assert.equal((await reactions())[0].count, 2);
  await owner.a.patch(S + '/emojis/' + emoji.eid, { name: 'renamed' });
  await member.a.put(reactionPath + encodeURIComponent(`<:renamed:${emoji.eid}>`));
  assert.equal((await reactions())[0].count, 2); // rename cannot create a second reaction
  assert.equal((await reactions())[0].name, 'renamed');
  // Old clients could store another name-bearing token after a rename.
  const memberRow = auth.userByPrincipal(member.user.id);
  db.run('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', Number(message.id), memberRow.id, `<:renamed:${emoji.eid}>`, Date.now());
  assert.equal((await reactions())[0].count, 2); // distinct people, not legacy token rows

  await member.a.del(reactionPath + encodeURIComponent(key));
  assert.equal((await reactions())[0].count, 1);
  await member.a.put(reactionPath + emoji.eid);
  await owner.a.del(S + '/emojis/' + emoji.eid);
  const deleted = (await reactions())[0];
  assert.equal(deleted.url, null); assert.ok(['pixel', 'renamed'].includes(deleted.name));
  assert.equal((await member.a.put(reactionPath + encodeURIComponent(key))).body.error, 'unknown_emoji');
  assert.equal((await member.a.del(reactionPath + encodeURIComponent(key))).status, 200);
  assert.equal((await reactions())[0].count, 1);
  assert.equal((await owner.a.del(reactionPath + encodeURIComponent(key))).status, 200);
  assert.deepEqual(await reactions(), []);
  // Unicode and custom reactions share the twenty-kind cap; repeat PUT stays idempotent.
  const values = Array.from({ length: 20 }, (_, i) => String.fromCodePoint(0x1f600 + i));
  for (const value of values) assert.equal((await member.a.put(reactionPath + encodeURIComponent(value))).status, 200);
  assert.equal((await member.a.put(reactionPath + encodeURIComponent(values[0]))).status, 200);
  assert.equal((await member.a.put(reactionPath + encodeURIComponent('\u{1f525}'))).body.error, 'too_many_reactions');
  const extraFile = file(); extraFile.append('name', 'extra');
  const extra = (await owner.a.raw('POST', S + '/emojis', extraFile)).body.emoji;
  assert.equal((await member.a.put(reactionPath + 'c:' + extra.eid)).body.error, 'too_many_reactions');
  await member.a.del(reactionPath + encodeURIComponent(values[0]));
  assert.equal((await member.a.put(reactionPath + 'c:' + extra.eid)).status, 200);
  // Another community's emoji cannot be newly added, even if a stale client knows its ID.
  const foreign = 'effffffffff';
  const other = db.run("INSERT INTO communities (sid, name, invite_code, owner_id, created_at) VALUES ('sforeign', 'Foreign', 'foreigncode', ?, ?)", c.owner_id, Date.now()).lastInsertRowid;
  db.run('INSERT INTO emojis (eid, community_id, name, file, created_at) VALUES (?, ?, ?, ?, ?)', foreign, Number(other), 'foreign', 'unused.png', Date.now());
  assert.equal((await member.a.put(reactionPath + 'c:' + foreign)).body.error, 'unknown_emoji');
  await override([{ rid: everyone.rid, deny: 1024, allow: 0 }]);
  assert.equal((await member.a.put(reactionPath + encodeURIComponent('\u{1f525}'))).status, 404);
});
