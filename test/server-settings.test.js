'use strict';
// Server settings (PROTOCOL §6.4): joining modes, member limit, roles new members get, message rules, AutoMod, timeouts,
// reports, the audit log, upload rules and the dashboard.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir, api } = require('./helpers');
const { startServer } = require('../src/index');
const M = require('../src/messages');
const db = require('../src/db');
const uploads = require('../src/uploads');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_MANAGED;
const dir = tmpDir();
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const form = (buf, name, fields = {}) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); f.append('file', new Blob([buf]), name); return f; };
let inst, owner, sid, cid, S;

test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} }); });
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const people = {};
async function person(name) {
  if (people[name]) return people[name];
  const r = await api(inst.url).post('/api/v1/auth/register', { username: name, password: 'correct horse battery' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  people[name] = { ...r.body, a: api(inst.url, r.body.session) };
  return people[name];
}
const settings = body => owner.a.patch(S + '/settings', body);
const post = (who, message) => { M._sendLimit.reset(); return who.a.post(`/api/v1/channels/${cid}/messages`, { message }); };

test('setup', async () => {
  owner = await person('owner');
  assert.equal((await owner.a.post('/api/v1/instance/claim', { code: inst.setup.current() })).status, 200);
  const d = (await owner.a.post('/api/v1/servers', { name: 'Camp', join_policy: 'open' })).body;
  sid = d.server.sid; cid = d.channels.find(c => c.type === 'text').cid; S = `/api/v1/servers/${sid}`;
  const s = (await owner.a.get(S + '/settings')).body.settings;
  assert.equal(s.join_policy, 'open');
  assert.equal(s.messages.max_length, 4000);
  assert.equal(s.has_password, false);
  assert.equal(s.instance_admin, true);
});

test('joining: password, allowlist, invite only, member limit and roles new members get', async () => {
  const bob = await person('bob'), cat = await person('cat');
  // a password is needed before the password mode can be picked
  assert.equal((await settings({ join_policy: 'password' })).body.error, 'join_password_required');
  assert.equal((await settings({ join_policy: 'password', join_password: 'campfire' })).status, 200);
  assert.equal((await owner.a.get(S + '/settings')).body.settings.has_password, true);
  assert.equal((await bob.a.post(S + '/join')).body.error, 'password_required');
  assert.equal((await bob.a.post(S + '/join', { password: 'nope' })).body.error, 'wrong_password');
  assert.equal((await bob.a.post(S + '/join', { password: 'campfire' })).status, 200);
  // allowlist
  await settings({ join_policy: 'allowlist', join: { allowlist: ['@Dan'] } });
  assert.equal((await cat.a.post(S + '/join')).body.error, 'not_on_allowlist');
  const dan = await person('dan');
  // invite only (an invite link always gets in)
  await settings({ join_policy: 'invite' });
  assert.equal((await cat.a.post(S + '/join')).body.error, 'invite_only');
  const inv = (await owner.a.post(S + '/invites', {})).body;
  // roles new members get
  const role = (await owner.a.post(S + '/roles', { name: 'newbie' })).body.role;
  await settings({ join: { default_roles: [role.rid] } });
  assert.equal((await cat.a.post(`/api/v1/join/${inv.code}`)).status, 200);
  const members = (await owner.a.get(S + '/members')).body.members;
  assert.deepEqual(members.find(m => m.username === 'cat').roles, [role.rid]);
  assert.deepEqual(members.find(m => m.username === 'bob').roles, []);
  // member limit (people: owner, bob, cat = 3)
  await settings({ join_policy: 'allowlist', join: { max_members: 3 } });
  assert.equal((await dan.a.post(S + '/join')).body.error, 'server_full');
  await settings({ join: { max_members: null } });
  assert.equal((await dan.a.post(S + '/join')).status, 200);
  assert.equal((await owner.a.get(S)).body.server.member_cap, null);
  await settings({ join_policy: 'open' });
  // non-managers can't read or change the settings
  assert.equal((await bob.a.get(S + '/settings')).status, 403);
  assert.equal((await bob.a.patch(S + '/settings', { messages: { max_length: 5 } })).status, 403);
});

test('message rules: longest message, reactions per message, search results', async () => {
  const bob = await person('bob');
  assert.equal((await settings({ messages: { max_length: 10, max_reactions: 2, search_results: 2 } })).status, 200);
  assert.equal((await owner.a.get(S)).body.server.max_message_length, 10);
  const long = await post(bob, 'x'.repeat(11));
  assert.equal(long.body.error, 'message_too_long');
  assert.equal(long.body.max, 10);
  const m = (await post(bob, 'find me')).body.message;
  for (const t of ['find me 2', 'find me 3']) await post(bob, t);
  assert.equal((await bob.a.get(`${S}/search?q=find`)).body.messages.length, 2);
  for (const e of ['😀', '😎']) assert.equal((await bob.a.put(`/api/v1/messages/${m.id}/reactions/${encodeURIComponent(e)}`)).status, 200);
  assert.equal((await bob.a.put(`/api/v1/messages/${m.id}/reactions/${encodeURIComponent('🔥')}`)).body.error, 'too_many_reactions');
  await settings({ messages: { max_length: 4000, max_reactions: 20, search_results: 25 } });
  // the preview proxy reaches outside the chat: instance admins only (bob isn't one, even with Manage server)
  const mgr = (await owner.a.post(S + '/roles', { name: 'mgr', permissions: 4 })).body.role;
  await owner.a.put(`${S}/members/${encodeURIComponent(bob.user.id)}/roles/${mgr.rid}`);
  assert.equal((await bob.a.patch(S + '/settings', { messages: { preview_proxy: 'https://proxy.example/?limit=1' } })).body.error, 'instance_admin_only');
  assert.equal((await bob.a.patch(S + '/settings', { messages: { link_previews: false } })).status, 200);
  assert.equal((await bob.a.get('/api/v1/unfurl?url=' + encodeURIComponent('https://example.com'))).body.embed, null);
  assert.equal((await settings({ messages: { link_previews: true, preview_proxy: 'https://proxy.example/?limit=1' } })).status, 200);
  assert.equal((await settings({ messages: { preview_proxy: 'ftp://nope' } })).body.error, 'invalid_preview_proxy');
  assert.equal(require('../src/unfurl').proxied('https://p.example/?url=&limit=5', 'https://a.b/c?d=1'), 'https://p.example/?url=https%3A%2F%2Fa.b%2Fc%3Fd%3D1&limit=5');
  assert.equal(require('../src/unfurl').proxied('https://p.example/get/{url}', 'https://a.b/'), 'https://p.example/get/https%3A%2F%2Fa.b%2F');
  await owner.a.del(`${S}/members/${encodeURIComponent(bob.user.id)}/roles/${mgr.rid}`);
});

test('AutoMod: blocked words time the sender out; exempt roles and the owner skip it; word list file; spam limits', async () => {
  const bob = await person('bob'), cat = await person('cat');
  fs.writeFileSync(path.join(dir, 'words.txt'), '# list\nfrogs\n');
  assert.equal((await settings({ automod: { word_file: '../etc/passwd' } })).body.error, 'invalid_word_file');
  assert.equal((await settings({ automod: { words_enabled: true, words: ['heck'], word_file: 'words.txt', timeout_seconds: 60 } })).status, 200);
  assert.equal((await post(bob, 'what the hecking')).status, 200); // whole words only
  const blocked = await post(bob, 'what the HECK');
  assert.equal(blocked.body.error, 'automod_blocked');
  assert.ok(blocked.body.until > Date.now());
  assert.equal((await post(bob, 'sorry')).body.error, 'timed_out');
  assert.equal((await post(cat, 'i like frogs')).body.error, 'automod_blocked'); // from the file
  assert.equal((await post(owner, 'heck')).status, 200);
  // timeouts: listed and lifted by moderators
  const t = (await owner.a.get(S + '/timeouts')).body.timeouts;
  assert.deepEqual(t.map(x => x.user.username).sort(), ['bob', 'cat']);
  await owner.a.del(`${S}/timeouts/${encodeURIComponent(bob.user.id)}`);
  await owner.a.del(`${S}/timeouts/${encodeURIComponent(cat.user.id)}`);
  assert.equal((await post(bob, 'fine')).status, 200);
  // exempt roles; case matching
  const vip = (await owner.a.post(S + '/roles', { name: 'vip' })).body.role;
  await owner.a.put(`${S}/members/${encodeURIComponent(bob.user.id)}/roles/${vip.rid}`);
  await settings({ automod: { exempt_roles: [vip.rid], match_case: true, timeout_seconds: 0 } });
  assert.equal((await post(bob, 'heck')).status, 200);
  assert.equal((await post(cat, 'HECK')).status, 200); // case must match now
  assert.equal((await post(cat, 'heck')).body.error, 'automod_blocked');
  assert.equal((await post(cat, 'ok')).status, 200); // timeout 0: blocked, not timed out
  await settings({ automod: { words_enabled: false } });
  // spam: 3 a minute, then a pause
  await settings({ automod: { spam_enabled: true, spam_per_minute: 3, spam_burst: 10, spam_pause_seconds: 30 } });
  require('../src/moderation')._spam.clear();
  for (let i = 0; i < 3; i++) assert.equal((await post(cat, 'msg ' + i)).status, 200);
  const slow = await post(cat, 'one more');
  assert.equal(slow.status, 429);
  assert.equal(slow.body.error, 'slow_down');
  assert.equal((await post(cat, 'again')).body.error, 'timed_out');
  await owner.a.del(`${S}/timeouts/${encodeURIComponent(cat.user.id)}`);
  await settings({ automod: { spam_enabled: false } });
});

test('timeouts: moderators time people out for a set time; no posting, reacting or voice until it ends', async () => {
  const bob = await person('bob'), cat = await person('cat');
  const m = (await post(owner, 'react to me')).body.message;
  const vc = (await owner.a.post(S + '/channels', { name: 'talk', type: 'voice' })).body.channel;
  // only Kick / Ban, never the owner, never someone as high as you
  assert.equal((await cat.a.post(S + '/timeouts', { user_id: bob.user.id, seconds: 60 })).status, 403);
  assert.equal((await owner.a.post(S + '/timeouts', { user_id: bob.user.id, seconds: 0 })).body.error, 'invalid_timeout');
  const r = await owner.a.post(S + '/timeouts', { user_id: bob.user.id, seconds: 600, reason: 'cool off' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.until > Date.now() + 590000);
  assert.equal((await post(bob, 'hello?')).body.error, 'timed_out');
  assert.equal((await bob.a.put(`/api/v1/messages/${m.id}/reactions/${encodeURIComponent('😀')}`)).body.error, 'timed_out');
  assert.equal(require('../src/voice').voiceDenied(bob.user ? { id: db.get('SELECT id FROM users WHERE principal = ?', bob.user.id).id } : null, `bf_${vc.cid}`), 'timed_out');
  assert.ok((await bob.a.get(S)).body.server.timeout_until > Date.now());
  assert.ok((await owner.a.get(S + '/members')).body.members.find(x => x.username === 'bob').timeout_until > Date.now());
  // a moderator can shorten it, and the audit log has it
  assert.ok((await owner.a.post(S + '/timeouts', { user_id: bob.user.id, seconds: 30 })).body.until < Date.now() + 31000);
  assert.ok((await owner.a.get(S + '/audit?action=member_timeout')).body.entries.length >= 2);
  await owner.a.del(`${S}/timeouts/${encodeURIComponent(bob.user.id)}`);
  assert.equal((await bob.a.put(`/api/v1/messages/${m.id}/reactions/${encodeURIComponent('😀')}`)).status, 200);
  assert.equal((await post(bob, 'back')).status, 200);
  assert.equal((await bob.a.post(S + '/timeouts', { user_id: owner.user.id, seconds: 60 })).status, 403);
});

test('reports: members report messages and members; moderators see, resolve and dismiss them', async () => {
  const bob = await person('bob'), cat = await person('cat');
  const m = (await post(bob, 'rude thing')).body.message;
  const r1 = await cat.a.post(S + '/reports', { message_id: m.id, reason: 'rude' });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal((await cat.a.post(S + '/reports', { message_id: m.id })).body.duplicate, true);
  assert.equal((await bob.a.post(S + '/reports', { message_id: m.id })).body.error, 'cannot_report_yourself');
  assert.equal((await cat.a.post(S + '/reports', { user_id: bob.user.id, reason: 'spams' })).status, 200);
  assert.equal((await cat.a.get(S + '/reports')).status, 403);
  const open = (await owner.a.get(S + '/reports?status=open')).body;
  assert.equal(open.open, 2);
  const msgReport = open.reports.find(r => r.kind === 'message');
  assert.equal(msgReport.message.body, 'rude thing');
  assert.equal(msgReport.target.username, 'bob');
  assert.equal(msgReport.reporter.username, 'cat');
  assert.equal((await owner.a.patch(`${S}/reports/${msgReport.id}`, { status: 'resolved', note: 'deleted it' })).body.report.status, 'resolved');
  const other = open.reports.find(r => r.kind === 'member');
  await owner.a.patch(`${S}/reports/${other.id}`, { status: 'dismissed' });
  assert.equal((await owner.a.get(S + '/reports?status=open')).body.reports.length, 0);
  assert.equal((await owner.a.get(S + '/reports?status=resolved')).body.reports[0].note, 'deleted it');
});

test('audit log: actions are recorded by category; retention prunes them', async () => {
  const bob = await person('bob');
  const m = (await post(bob, 'delete me')).body.message;
  await owner.a.del(`/api/v1/messages/${m.id}`);
  await owner.a.post(S + '/channels', { name: 'new-room' });
  const all = (await owner.a.get(S + '/audit')).body;
  const actions = all.entries.map(e => e.action);
  for (const a of ['message_delete', 'channel_create', 'settings_update', 'role_create', 'member_role_add', 'automod_block', 'report_resolve', 'report_dismiss', 'invite_create']) assert.ok(actions.includes(a), a);
  const mod = (await owner.a.get(S + '/audit?category=message_moderation')).body.entries;
  assert.ok(mod.length && mod.every(e => e.category === 'message_moderation'));
  assert.equal(mod.find(e => e.action === 'automod_block').automod, true);
  assert.equal((await owner.a.get(S + '/audit?action=channel_create')).body.entries[0].target.name, 'new-room');
  assert.equal((await bob.a.get(S + '/audit')).status, 403);
  // per-category retention: old channel entries go, others stay
  db.run('UPDATE audit_log SET created_at = ? WHERE category = ?', Date.now() - 5 * 86400000, 'channel_management');
  db.run('UPDATE audit_log SET created_at = ? WHERE action = ?', Date.now() - 5 * 86400000, 'message_delete');
  await settings({ audit: { retention: { channel_management: 2 } } });
  const after = (await owner.a.get(S + '/audit')).body.entries.map(e => e.action);
  assert.ok(!after.includes('channel_create'));
  assert.ok(after.includes('message_delete'));
  // switched off: nothing new is kept
  await settings({ audit: { enabled: false } });
  await owner.a.post(S + '/channels', { name: 'quiet-room' });
  assert.ok(!(await owner.a.get(S + '/audit?action=channel_create')).body.entries.length);
  await settings({ audit: { enabled: true } });
});

test('uploads: per minute, files each member keeps, allowed types, expiry, storage limit', async () => {
  const bob = await person('bob');
  const up = (who, buf = PNG, name = 'pixel.png', fields) => who.a.raw('POST', `/api/v1/media/upload?sid=${sid}&cid=${cid}`, form(buf, name, fields));
  await settings({ uploads: { per_minute: 2 } });
  assert.equal((await up(bob)).status, 200);
  assert.equal((await up(bob)).status, 200);
  assert.equal((await up(bob)).body.error, 'upload_rate_limited');
  assert.equal((await up(owner)).status, 200); // the owner isn't limited
  await settings({ uploads: { per_minute: 600, types: ['pdf', 'text'] } });
  assert.equal((await up(bob)).body.error, 'file_type_not_allowed');
  assert.equal((await up(bob, Buffer.from('hello'), 'notes.txt')).status, 200);
  assert.equal((await up(bob, Buffer.from('%PDF-1.4 x'), 'doc.pdf')).status, 200);
  assert.equal((await up(bob, Buffer.from([0x50, 0x4b, 3, 4, 0]), 'a.zip')).body.error, 'file_type_not_allowed');
  await settings({ uploads: { types: ['any'], files_per_member: 4 } }); // bob keeps 4 so far
  assert.equal((await up(bob)).body.error, 'upload_quota');
  // expiry: the longest a file is kept; members pick shorter; expired files stop counting and are swept
  await settings({ uploads: { files_per_member: null, expire_days: 7 } });
  const e1 = (await up(bob)).body;
  assert.ok(e1.expires_at > Date.now() + 6.9 * 86400000 && e1.expires_at <= Date.now() + 7 * 86400000);
  const e2 = (await up(bob, PNG, 'pixel.png', { expires_in_days: '1' })).body;
  assert.ok(e2.expires_at <= Date.now() + 86400000);
  const msg = (await bob.a.post(`/api/v1/channels/${cid}/messages`, { message: '', attachments: [e2] })).body.message;
  const rel = e2.url.split('/uploads/')[1];
  db.run('UPDATE uploads SET expires_at = ? WHERE path = ?', Date.now() - 1, rel);
  uploads.sweepExpired();
  assert.ok(!db.get('SELECT 1 FROM uploads WHERE path = ?', rel));
  assert.ok(!fs.existsSync(path.join(dir, 'uploads', rel)));
  const after = (await bob.a.get(`/api/v1/channels/${cid}/messages?limit=5`)).body.messages.find(x => x.id === msg.id);
  assert.equal(after.attachments[0].expired, true);
  // members with a listed role keep their files
  const keeper = (await owner.a.post(S + '/roles', { name: 'keeper' })).body.role;
  await settings({ uploads: { never_expire_roles: [keeper.rid] } });
  assert.ok((await up(bob)).body.expires_at > Date.now());
  await owner.a.put(`${S}/members/${encodeURIComponent(bob.user.id)}/roles/${keeper.rid}`);
  assert.ok(!(await up(bob)).body.expires_at);
  assert.equal((await owner.a.patch(S + '/settings', { uploads: { never_expire_roles: ['nope'] } })).body.error, 'invalid_roles');
  // storage limit
  await settings({ uploads: { expire_days: null, storage_mb: 1 } });
  assert.equal((await up(bob, Buffer.alloc(1100 * 1024, 7), 'big.bin')).body.error, 'storage_full');
  await settings({ uploads: { storage_mb: null } });
});

test('uploads: image compression resizes big pictures and refuses ones over the pixel limit', { skip: !require('../src/images').available() && 'sharp is not installed' }, async () => {
  const sharp = require('sharp');
  const big = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#c33' } }).jpeg().toBuffer();
  await settings({ uploads: { compress: true, max_width: 200, max_height: 200, max_pixels: 1000000, jpeg_quality: 60 } });
  const r = (await owner.a.raw('POST', `/api/v1/media/upload?sid=${sid}&cid=${cid}`, form(big, 'red.jpg'))).body;
  assert.equal(r.width, 200);
  assert.equal(r.height, 100);
  await settings({ uploads: { max_pixels: 100000 } });
  assert.equal((await owner.a.raw('POST', `/api/v1/media/upload?sid=${sid}&cid=${cid}`, form(big, 'red.jpg'))).body.error, 'image_too_large');
  await settings({ uploads: { compress: false } });
});

test('dashboard: counts, health, storage and top channels', async () => {
  require('../src/dashboard')._reset();
  const d = (await owner.a.get(S + '/dashboard')).body;
  assert.equal(d.members, 4);
  assert.equal(d.banned, 0);
  assert.ok(d.messages > 5);
  assert.ok(d.disk > 0);
  assert.ok(d.storage.some(s => s.key === 'messages' || s.key === 'other'));
  assert.ok(d.storage.some(s => s.key === 'uploads'));
  assert.match(d.health.runtime, /^Node /);
  assert.ok(d.health.memory > 0);
  assert.equal(d.channels.by_messages[0].name, 'general');
  assert.equal((await (await person('bob')).a.get(S + '/dashboard')).status, 403);
});
