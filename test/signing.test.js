'use strict';
// Message signing: canonical JSON, payload build, verification rules, and the HTTP/WS paths in a velora-mode instance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('crypto');
const { tmpDir, api, wsClient, fakeIdp } = require('./helpers');

process.env.BONFIRE_ACCOUNTS_MODE = 'velora';
process.env.BONFIRE_VELORA_URL = 'http://velora.test';
process.env.BONFIRE_PUBLIC_URL = 'https://chat.test';
delete process.env.BONFIRE_OWNER;
const { startServer } = require('../src/index');
const auth = require('../src/auth');
const signing = require('../src/signing');

// the device key (what a Ember client holds)
const dev = crypto.generateKeyPairSync('ed25519');
const rawPub = Buffer.from(dev.publicKey.export({ format: 'jwk' }).x, 'base64url');
const KID = 'k_' + crypto.createHash('sha256').update(rawPub).digest('hex').slice(0, 16);
let keyRecord = { kid: KID, user_id: '123', public_key: rawPub.toString('base64url'), created_at: Date.now() - 1000, revoked_at: null };
let keyLookups = 0;
const fetcher = async kid => { keyLookups++; return kid === KID ? { ...keyRecord } : null; };

const sign = (payload, key = dev.privateKey) => crypto.sign(null, signing.signingBytes(payload), key).toString('base64url');
const mk = (over = {}) => signing.buildPayload({ iss: 'http://velora.test', instance: 'https://chat.test', community: 's0123456789', channel: 'c0123456789', author: '123', ts: Date.now(), nonce: 'AAAAAAAAAAAAAAAAAAAAAA', body: 'hi', attachments: [], reply_to: null, edit_of: null, ...over });
const sigOf = p => ({ kid: KID, sig: sign(p), ts: p.ts, nonce: p.nonce });

test('canonical JSON: sorted keys, no whitespace, integers; fixed vector', () => {
  assert.equal(signing.canonical({ b: 1, a: [{ z: null, y: true }], c: 'é\n', d: 3.0, e: { } }), '{"a":[{"y":true,"z":null}],"b":1,"c":"é\\n","d":3,"e":{}}');
  const p = signing.buildPayload({ iss: 'i', instance: 'x', community: 's', channel: 'c', author: 7, ts: 5, nonce: 'n', body: 'b', attachments: ['ab'], reply_to: 9, edit_of: null });
  assert.equal(signing.canonical(p), '{"attachments":["ab"],"author":"7","body":"b","channel":"c","community":"s","edit_of":null,"instance":"x","iss":"i","nonce":"n","reply_to":"9","ts":5,"v":1}');
  assert.equal(signing.signingBytes(p).toString().startsWith('bonfire-msg-v1\n{"attachments"'), true);
});

test('verify: good signature, tampering, wrong user, revoked-before-ts, skew, unknown key', async () => {
  signing.setKeyFetcher(fetcher);
  keyRecord.revoked_at = null;
  const p = mk();
  assert.deepEqual(await signing.verify({ payload: p, signature: sigOf(p), veloraId: '123' }), { ok: true });
  // a different body => the signature no longer matches
  const q = { ...p, body: 'tampered' };
  assert.equal((await signing.verify({ payload: q, signature: sigOf(p), veloraId: '123' })).reason, 'bad_signature');
  // same key, other account
  assert.equal((await signing.verify({ payload: p, signature: sigOf(p), veloraId: '999' })).reason, 'wrong_user');
  // a garbage signature
  assert.equal((await signing.verify({ payload: p, signature: { ...sigOf(p), sig: 'AAAA' }, veloraId: '123' })).reason, 'bad_signature');
  // unknown key
  assert.equal((await signing.verify({ payload: p, signature: { ...sigOf(p), kid: 'k_nope' }, veloraId: '123' })).reason, 'unknown_key');
  // ts / nonce in the envelope must match the payload
  assert.equal((await signing.verify({ payload: p, signature: { ...sigOf(p), nonce: 'other' }, veloraId: '123' })).reason, 'mismatch');
  // clock window: +-5 minutes
  const old = mk({ ts: Date.now() - 6 * 60 * 1000 });
  assert.equal((await signing.verify({ payload: old, signature: sigOf(old), veloraId: '123' })).reason, 'timestamp');
  const edge = mk({ ts: Date.now() - 4 * 60 * 1000 });
  assert.equal((await signing.verify({ payload: edge, signature: sigOf(edge), veloraId: '123' })).ok, true);
  // revoked: before the message's ts => refused; after it => the message predates the revocation and is fine
  signing.setKeyFetcher(fetcher);
  keyRecord.revoked_at = p.ts - 1;
  assert.equal((await signing.verify({ payload: p, signature: sigOf(p), veloraId: '123' })).reason, 'revoked');
  signing.setKeyFetcher(fetcher);
  keyRecord.revoked_at = p.ts + 1000;
  assert.equal((await signing.verify({ payload: p, signature: sigOf(p), veloraId: '123' })).ok, true);
  keyRecord.revoked_at = null;
});

test('key lookups are cached for ten minutes', async () => {
  signing.setKeyFetcher(fetcher);
  keyLookups = 0;
  const p = mk();
  for (let i = 0; i < 3; i++) await signing.verify({ payload: p, signature: sigOf(p), veloraId: '123' });
  assert.equal(keyLookups, 1);
});

// ---------- over HTTP / WS ----------
const idp = fakeIdp();
const dir = tmpDir();
let inst, a, b, sid, cid, wsA;
test.before(async () => { inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1' }); auth.setJwksFetcher(idp.jwks); signing.setKeyFetcher(fetcher); });
test.after(async () => { wsA?.close(); await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('signed messages end to end', async () => {
  keyRecord.revoked_at = null; signing.setKeyFetcher(fetcher);
  const la = await api(inst.url).post('/api/v1/auth/velora', { token: idp.mint({ sub: '123', username: 'nat' }) });
  const lb = await api(inst.url).post('/api/v1/auth/velora', { token: idp.mint({ sub: '124', username: 'sam', scp: ['chat'] }) });
  a = api(inst.url, la.body.session); b = api(inst.url, lb.body.session);
  assert.equal((await a.post('/api/v1/instance/claim', { code: inst.setup.current() })).status, 200); // the owner sets the community up
  const d = (await a.post('/api/v1/servers', { name: 'Signed', join_policy: 'open' })).body;
  sid = d.server.sid; cid = d.channels.find(c => c.type === 'text').cid;
  assert.equal((await b.post(`/api/v1/servers/${sid}/join`)).status, 200);
  const payload = over => mk({ community: sid, channel: cid, ...over });

  // signing is always allowed in velora mode (no community switch), and can never be required: old fields are ignored
  let p = payload();
  let r;
  assert.equal(d.server.allow_signing, true);
  const old = (await a.patch(`/api/v1/servers/${sid}`, { allow_signing: false, require_signing: true })).body.server;
  assert.equal(old.allow_signing, true);
  assert.equal(old.require_signing, undefined);

  // good signature => stored + returned
  r = await a.post(`/api/v1/channels/${cid}/messages`, { message: 'hi', signature: sigOf(p) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.message.signature, sigOf(p));
  assert.equal(r.body.message.verified, true);
  const id = r.body.message.id;

  // bad signature (signed other text) / replayed-as-other-channel payload
  p = payload({ body: 'something else' });
  r = await a.post(`/api/v1/channels/${cid}/messages`, { message: 'hi', signature: sigOf(p) });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'bad_signature');
  p = payload({ channel: 'cffffffffff' });
  assert.equal((await a.post(`/api/v1/channels/${cid}/messages`, { message: 'hi', signature: sigOf(p) })).body.error, 'bad_signature');

  // sessions without the sign scope may not send signed messages
  p = payload();
  assert.equal((await b.post(`/api/v1/channels/${cid}/messages`, { message: 'hi', signature: sigOf(p) })).body.error, 'insufficient_scope');

  // reply_to is part of the payload
  p = payload({ nonce: 'BBBBBBBBBBBBBBBBBBBBBB', body: 'a reply', reply_to: id });
  r = await a.post(`/api/v1/channels/${cid}/messages`, { message: 'a reply', reply_to: id, signature: sigOf(p) });
  assert.equal(r.body.message.verified, true);

  // signed attachment hashes come from the upload response
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('plain bytes')]), 'notes.txt');
  const up = (await a.raw('POST', `/api/v1/media/upload?sid=${sid}`, fd)).body;
  p = payload({ nonce: 'CCCCCCCCCCCCCCCCCCCCCC', body: 'with file', attachments: [up.sha256] });
  r = await a.post(`/api/v1/channels/${cid}/messages`, { message: 'with file', attachments: [up], signature: sigOf(p) });
  assert.equal(r.body.message.verified, true);
  assert.equal(r.body.message.attachments[0].sha256, up.sha256);

  // edits: signed with edit_of; an unsigned edit clears the signature
  p = payload({ nonce: 'DDDDDDDDDDDDDDDDDDDDDD', body: 'hi (edited)', edit_of: id });
  r = await a.patch(`/api/v1/messages/${id}`, { message: 'hi (edited)', signature: sigOf(p) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.message.verified, true);
  r = await a.patch(`/api/v1/messages/${id}`, { message: 'hi (unsigned edit)' });
  assert.equal(r.body.message.signature, null);
  assert.equal(r.body.message.verified, null);

  // revoked key
  signing.setKeyFetcher(fetcher);
  keyRecord.revoked_at = Date.now() - 60000;
  p = payload({ nonce: 'EEEEEEEEEEEEEEEEEEEEEE' });
  assert.equal((await a.post(`/api/v1/channels/${cid}/messages`, { message: 'hi', signature: sigOf(p) })).body.error, 'bad_signature');
  keyRecord.revoked_at = null; signing.setKeyFetcher(fetcher);

  // unsigned velora messages are always accepted (unverified)
  r = await a.post(`/api/v1/channels/${cid}/messages`, { message: 'unsigned' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.message.signature, null);
  assert.equal(r.body.message.verified, null);
  assert.equal((await b.post(`/api/v1/channels/${cid}/messages`, { message: 'unsigned too' })).status, 200);

  // and over the websocket
  // (a third account, so the 8-messages-per-5-seconds limit of the first one doesn't get in the way)
  keyRecord.user_id = '125';
  const ld = await api(inst.url).post('/api/v1/auth/velora', { token: idp.mint({ sub: '125', username: 'kit' }) });
  assert.equal((await api(inst.url, ld.body.session).post(`/api/v1/servers/${sid}/join`)).status, 200);
  signing.setKeyFetcher(fetcher);
  wsA = await wsClient(inst.url).login(ld.body.session);
  p = payload({ nonce: 'FFFFFFFFFFFFFFFFFFFFFF', body: 'via ws', author: '125' });
  wsA.send({ type: 'chat_send', nonce: 'w1', channel: cid, message: 'via ws', signature: sigOf(p) });
  const ack = await wsA.waitFor(f => (f.type === 'chat_ack' || f.type === 'chat_error') && f.nonce === 'w1');
  assert.equal(ack.error, undefined, JSON.stringify(ack));
  assert.equal(ack.message.verified, true);
  wsA.send({ type: 'chat_send', nonce: 'w2', channel: cid, message: 'via ws' });
  const ack2 = await wsA.waitFor(f => (f.type === 'chat_ack' || f.type === 'chat_error') && f.nonce === 'w2');
  assert.equal(ack2.error, undefined, JSON.stringify(ack2));
  assert.equal(ack2.message.verified, null);
});


test('attachment references bind hashes and link-only GIF URLs in order', async () => {
  keyRecord.user_id = '123'; keyRecord.revoked_at = null; signing.setKeyFetcher(fetcher);
  const upload = { url: 'https://chat.test/uploads/notes.txt', sha256: 'a'.repeat(64) };
  const gif = { url: 'https://static.klipy.com/giphy/cat.gif' };
  const refs = signing.attachmentRefs([upload, gif]);
  assert.deepEqual(refs, [upload.sha256, 'url:' + gif.url]);
  assert.deepEqual(signing.attachmentRefs([{ ...gif, sha256: upload.sha256 }]), [upload.sha256]); // legacy hash entry
  assert.throws(() => signing.attachmentRefs([{ url: 'https://elsewhere.test/file' }]), /missing_attachment_hash/);
  for (const body of ['', 'caption']) {
    const p = mk({ body, attachments: refs, reply_to: '42', edit_of: '43' });
    const signature = sigOf(p);
    assert.equal((await signing.verify({ payload: p, signature, veloraId: '123' })).ok, true);
    for (const attachments of [[...refs].reverse(), [upload.sha256], [upload.sha256, 'url:' + gif.url + '?changed=1'], ['b'.repeat(64), refs[1]]]) {
      assert.equal((await signing.verify({ payload: { ...p, attachments }, signature, veloraId: '123' })).reason, 'bad_signature');
    }
  }
});

test('signed GIFs and saved uploads: HTTP, gateway, replies, edits and history', async () => {
  keyRecord.user_id = '126'; keyRecord.revoked_at = null; signing.setKeyFetcher(fetcher);
  const login = await api(inst.url).post('/api/v1/auth/velora', { token: idp.mint({ sub: '126', username: 'media' }) });
  const client = api(inst.url, login.body.session);
  assert.equal((await client.post(`/api/v1/servers/${sid}/join`)).status, 200);
  const payload = over => mk({ author: '126', community: sid, channel: cid, ...over });
  const fd = new FormData();
  fd.append('file', new Blob(['saved media bytes']), 'saved.txt');
  const uploaded = await client.raw('POST', `/api/v1/media/upload?sid=${sid}`, fd);
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  const up = uploaded.body;
  const gif = { url: 'https://static.klipy.com/giphy/cat.gif', type: 'gif', name: 'cat' };
  const attachments = [up, gif];
  const p = payload({ body: '', attachments: signing.attachmentRefs(attachments) });
  const ws = await wsClient(inst.url).login(login.body.session);
  try {
    ws.send({ type: 'chat_send', nonce: 'media1', channel: cid, message: '', attachments, signature: sigOf(p) });
    const ack = await ws.waitFor(f => (f.type === 'chat_ack' || f.type === 'chat_error') && f.nonce === 'media1');
    assert.equal(ack.error, undefined, JSON.stringify(ack));
    assert.equal(ack.message.verified, true);
    assert.deepEqual(signing.attachmentRefs(ack.message.attachments), p.attachments);
    const target = ack.message.id;
    let rp = payload({ body: 'caption', attachments: ['url:' + gif.url], reply_to: target });
    let r = await client.post(`/api/v1/channels/${cid}/messages`, { message: 'caption', attachments: [gif], reply_to: target, signature: sigOf(rp) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.message.verified, true);
    const id = r.body.message.id;
    const { receivedPayload, canonical } = await import('../../dashboard-src/src/chat/signing-payload.js');
    const checkClient = m => {
      const incoming = { ...m, inst: 'https://chat.test', server: `https://chat.test|${m.server}`, channel: `https://chat.test|${m.channel}` };
      const bytes = Buffer.from('bonfire-msg-v1\n' + canonical(receivedPayload(incoming, 'http://velora.test')));
      assert.equal(crypto.verify(null, bytes, dev.publicKey, Buffer.from(m.signature.sig, 'base64url')), true);
    };
    checkClient(ack.message);
    checkClient(r.body.message);
    rp = payload({ body: 'edited caption', attachments: ['url:' + gif.url], reply_to: target, edit_of: id });
    r = await client.patch(`/api/v1/messages/${id}`, { message: rp.body, signature: sigOf(rp) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.message.verified, true);
    checkClient(r.body.message);
    // Deleting a reply target must not change the fields used for verification or the next edit.
    assert.equal((await client.del(`/api/v1/messages/${target}`)).status, 200);
    const history = await client.get(`/api/v1/channels/${cid}/messages`);
    const fromHistory = history.body.messages.find(m => m.id === id);
    assert.equal(fromHistory.reply, null);
    assert.equal(fromHistory.reply_to, target);
    checkClient(fromHistory);
    rp = payload({ body: '', attachments: ['url:' + gif.url], reply_to: target, edit_of: id });
    r = await client.patch(`/api/v1/messages/${id}`, { message: '', signature: sigOf(rp) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    checkClient(r.body.message);
    // An altered URL cannot reuse a signature for the original GIF.
    const bad = payload({ body: '', attachments: ['url:' + gif.url] });
    r = await client.post(`/api/v1/channels/${cid}/messages`, { message: '', attachments: [{ ...gif, url: gif.url + '?changed=1' }], signature: sigOf(bad) });
    assert.equal(r.body.error, 'bad_signature');
  } finally { ws.close(); }
});
