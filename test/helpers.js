'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

// tests never contact a real Velora unless they ask for it (relay.test.js runs its own stub Velora)
process.env.BONFIRE_VELORA_REGISTRATION ??= 'off';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bonfire-test-'));

// tiny JSON client: const a = api(base, token); await a.post('/servers', {...}) -> { status, body }
function api(base, token) {
  const call = async (method, p, body, headers = {}) => {
    const h = { ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    let payload;
    if (body !== undefined && !(body instanceof Uint8Array) && !(body instanceof FormData)) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); } else payload = body;
    const r = await fetch(base + p, { method, headers: h, body: payload });
    const ct = r.headers.get('content-type') || '';
    const out = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
    return { status: r.status, body: out, headers: r.headers };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b ?? {}), patch: (p, b) => call('PATCH', p, b ?? {}), del: (p) => call('DELETE', p), raw: call };
}

// websocket client that records every frame
function wsClient(url) {
  const ws = new WebSocket(url.replace(/^http/, 'ws') + '/gateway');
  const frames = [], waiters = [];
  ws.on('message', raw => {
    const f = JSON.parse(raw.toString());
    frames.push(f);
    for (const w of [...waiters]) if (w.pred(f)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.t); w.resolve(f); }
  });
  const closed = new Promise(res => ws.on('close', (code, reason) => res({ code, reason: reason.toString() })));
  const c = {
    ws, frames, closed,
    open: () => new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); }),
    send: o => ws.send(JSON.stringify(o)),
    waitFor: (pred, ms = 4000) => {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, t: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('timeout waiting for frame; got: ' + frames.map(f => f.type).join(','))); }, ms) };
        waiters.push(w);
      });
    },
    // auth + chat_hello, resolves once chat_ready
    async login(session) {
      await c.open();
      c.send({ type: 'auth', session });
      await c.waitFor(f => f.type === 'auth_success');
      c.send({ type: 'chat_hello' });
      await c.waitFor(f => f.type === 'chat_ready');
      return c;
    },
    close: () => { try { ws.close(); } catch { /* closed */ } },
  };
  return c;
}
module.exports = { tmpDir, api, wsClient };

// a stand-in for Velora's identity provider: Ed25519 key, JWKS, instance-token minting
const crypto = require('crypto');
function fakeIdp({ kid = 'testkid1', iss = 'http://velora.test', aud = 'https://chat.test' } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' };
  const b64 = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const idp = {
    iss, aud, kid, privateKey, publicKey, jwk, jwksFetches: 0,
    jwks: async () => { idp.jwksFetches++; return { keys: [jwk] }; },
    mint(over = {}, { key = privateKey, kid: k = kid, alg = 'EdDSA' } = {}) {
      const iat = Math.floor(Date.now() / 1000);
      const claims = { iss, sub: '123', aud, iat, exp: iat + 600, jti: crypto.randomBytes(16).toString('base64url'), username: 'nat', display_name: 'nat', pfp: null, scp: ['chat', 'voice', 'media', 'sign'], ...over };
      const head = b64({ alg, typ: 'JWT', kid: k });
      const body = b64(claims);
      return `${head}.${body}.${crypto.sign(null, Buffer.from(head + '.' + body), key).toString('base64url')}`;
    },
  };
  return idp;
}
module.exports.fakeIdp = fakeIdp;
