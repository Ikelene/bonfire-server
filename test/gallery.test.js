'use strict';
// Bot gallery on the instance (PROTOCOL §14.1): add a gallery bot with a Velora add-ticket, its token hash comes from Velora,
// verified flag, managed profile, and sync (fresh profile, revoke).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const { startServer } = require('../src/index');
const auth = require('../src/auth');
const client = require('../src/relay/client');
const gallery = require('../src/relay/gallery');
const { tmpDir, api, fakeIdp } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'velora';
process.env.BONFIRE_VELORA_URL = 'http://velora.test/';
process.env.BONFIRE_PUBLIC_URL = 'http://chat.test';
process.env.BONFIRE_OWNER = 'v:100';

const dir = tmpDir();
const idp = fakeIdp({ iss: 'http://velora.test', aud: 'http://chat.test' });
let inst, base, owner, other, sid;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = 'NzA.secret-token-from-velora';

function ticket(over = {}, { typ = gallery.TYP } = {}) {
  const iat = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'http://velora.test', aud: 'http://chat.test', sub: '100', iat, exp: iat + 300, jti: crypto.randomBytes(16).toString('base64url'), test: false, verified: true,
    token_hash: sha(TOKEN), bot: { id: '70', username: 'DJ_Bot', description: 'plays music', avatar_url: 'https://velora.test/uploads/bots/dj.png' }, ...over,
  };
  const head = b64({ alg: 'EdDSA', typ, kid: idp.kid }), body = b64(claims);
  return `${head}.${body}.${crypto.sign(null, Buffer.from(head + '.' + body), idp.privateKey).toString('base64url')}`;
}
const login = async (sub, username) => {
  const r = await api(base).post('/api/v1/auth/velora', { token: idp.mint({ sub: String(sub), username }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...r.body, a: api(base, r.body.session) };
};

test.before(async () => {
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1', restart: () => {} });
  base = inst.url;
  auth.setJwksFetcher(idp.jwks);
  owner = await login(100, 'owner'); other = await login(200, 'other');
  sid = (await owner.a.post('/api/v1/servers', { name: 'Hall', join_policy: 'open' })).body.server.sid;
  await other.a.post(`/api/v1/servers/${sid}/join`);
});
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('a manager adds a gallery bot with a ticket: verified, managed profile, its token works locally', async () => {
  const r = await owner.a.post('/api/v1/bots/gallery/add', { ticket: ticket(), sid });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.bot.username, 'DJ_Bot');
  assert.equal(r.body.bot.verified, true);
  assert.deepEqual(r.body.bot.gallery, { id: '70', test: false });
  const members = (await owner.a.get(`/api/v1/servers/${sid}/members`)).body;
  const m = (members.members || members).find(x => x.username === 'DJ_Bot');
  assert.ok(m && m.bot === true && m.verified === true, JSON.stringify(m));
  // the developer's token (hash from Velora) authenticates against this instance's bot API
  const me = await fetch(`${base}/bot/v1/users/@me`, { headers: { Authorization: 'Bot ' + TOKEN } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).verified, true);
  assert.equal((await fetch(`${base}/bot/v1/users/@me`, { headers: { Authorization: 'Bot wrong' } })).status, 401);
});

test('tickets are single use, for one person and one instance, and must be the right type', async () => {
  const t = ticket({ bot: { id: '71', username: 'Other', description: 'x', avatar_url: null }, token_hash: sha('t71') });
  const bad = async (tk, who, want) => { const r = await who.a.post('/api/v1/bots/gallery/add', { ticket: tk, sid }); assert.equal(r.body.error, want, JSON.stringify(r.body)); };
  await bad(t, other, 'not_allowed'); // other has no Manage server (checked before the ticket is spent)
  await bad(ticket({ sub: '999' }), owner, 'ticket_wrong_user');
  await bad(ticket({ aud: 'http://elsewhere.test' }), owner, 'ticket_wrong_audience');
  await bad(ticket({}, { typ: 'JWT' }), owner, 'ticket_invalid');
  await bad(ticket({ exp: Math.floor(Date.now() / 1000) - 600 }), owner, 'ticket_expired');
  assert.equal((await owner.a.post('/api/v1/bots/gallery/add', { ticket: t, sid })).status, 200);
  await bad(t, owner, 'ticket_used');
  await bad(ticket(), owner, 'already_in_server');
});

test('gallery bots are managed by Velora: no rename / token reset, but a manager can remove them', async () => {
  const bots = (await owner.a.get('/api/v1/bots')).body.bots;
  const dj = bots.find(b => b.username === 'DJ_Bot');
  assert.equal((await owner.a.patch(`/api/v1/bots/${dj.id}`, { description: 'x' })).body.error, 'gallery_bot_managed');
  assert.equal((await owner.a.post(`/api/v1/bots/${dj.id}/token`)).body.error, 'gallery_bot_managed');
});

test('sync refreshes the profile and token hash, and a revoked bot is removed', async () => {
  const realReg = client.registered, realCall = client.call;
  const calls = [];
  client.registered = () => true;
  client.call = async (method, p, body) => {
    calls.push({ method, p, body });
    return { bots: [
      { id: '70', status: 'ok', verified: false, token_hash: sha('NzA.rotated'), username: 'DJ_Bot', description: 'new text', avatar_url: 'https://velora.test/uploads/bots/new.png', trusted_in: 12 },
      { id: '71', status: 'revoked' },
    ] };
  };
  try {
    await gallery.sync();
    assert.equal(calls[0].p, '/bonfire/relay/bots/sync');
    assert.deepEqual(calls[0].body.bots.map(b => b.id).sort(), ['70', '71']);
    const bots = (await owner.a.get('/api/v1/bots')).body.bots;
    assert.equal(bots.find(b => b.username === 'DJ_Bot').trusted_in, 12);
    assert.equal(bots.find(b => b.username === 'DJ_Bot').verified, false);
    assert.equal(bots.find(b => b.username === 'Other'), undefined, 'revoked bot is gone');
    assert.equal((await fetch(`${base}/bot/v1/users/@me`, { headers: { Authorization: 'Bot ' + TOKEN } })).status, 401, 'old token hash no longer works');
    assert.equal((await fetch(`${base}/bot/v1/users/@me`, { headers: { Authorization: 'Bot NzA.rotated' } })).status, 200);
  } finally { client.registered = realReg; client.call = realCall; }
});
