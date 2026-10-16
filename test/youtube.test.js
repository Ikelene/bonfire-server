'use strict';
// The optional YouTube player: feature off -> 503, id validation (no shell), HMAC-signed stream links, cache cap, concurrency.
// A fake yt-dlp (a node script) stands in for the real binary, so none of this needs yt-dlp installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer } = require('../src/index');
const { tmpDir, api } = require('./helpers');
const yt = require('../src/youtube');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_OWNER;
const dir = tmpDir(), tools = tmpDir();
const log = path.join(tools, 'calls.log');
const fake = path.join(tools, 'yt-dlp');
// --version -> prints; otherwise writes the file named by -o (template %(ext)s -> mp4), slowly, logging its arguments
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs'); const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('2099.01.01'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const out = a[a.indexOf('-o') + 1].replace('%(ext)s', 'mp4');
console.log('[download] Destination: ' + out);
setTimeout(() => console.log('[download]  50.0% of 1MiB'), 50);
setTimeout(() => { fs.writeFileSync(out, Buffer.from('0123456789'.repeat(100))); process.exit(0); }, Number(process.env.FAKE_YT_MS || 400));
`, { mode: 0o755 });
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ youtube: { ytdlp_path: '/nonexistent/yt-dlp' } }));

let inst, alice, base;
test.before(async () => {
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1' }); base = inst.url;
  const r = await api(base).post('/api/v1/auth/register', { username: 'alice', password: 'correct horse battery' });
  alice = api(base, r.body.session);
  await alice.post('/api/v1/instance/claim', { code: inst.setup.current() });
});
test.after(async () => { await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(tools, { recursive: true, force: true }); });

const ID = 'dQw4w9WgXcQ';
const poll = async (fn, ms = 5000) => { for (let t = Date.now(); Date.now() - t < ms;) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 40)); } throw new Error('timeout'); };

test('without yt-dlp the feature is off: discovery says so and every route is 503', async () => {
  assert.equal(yt.enabled(), false);
  assert.equal((await api(base).get('/.well-known/bonfire')).body.features.youtube, false);
  assert.equal((await api(base).post(`/api/v1/yt/${ID}/prepare`)).status, 401); // a session is required first
  for (const [m, p] of [['post', `/yt/${ID}/prepare`], ['get', `/yt/${ID}/status`], ['post', `/yt/${ID}/save`], ['get', `/yt/stream/${ID}?e=1&s=x`]]) {
    const r = m === 'get' ? await alice.get('/api/v1' + p) : await alice.post('/api/v1' + p);
    assert.deepEqual([r.status, r.body], [503, { error: 'youtube_unavailable' }], p);
  }
  assert.equal((await api(base).get(`/api/v1/yt/stream/${ID}?e=1&s=x`)).status, 503); // the signed-link route needs no session but is off too
  // explicitly disabling it also turns it off, even with a working binary
  assert.equal((await alice.patch('/api/v1/instance/settings', { youtube: { enabled: false, ytdlp_path: fake } })).status, 200);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(yt.enabled(), false);
  assert.equal((await alice.post(`/api/v1/yt/${ID}/prepare`)).status, 503);
});

test('settings are validated; a working binary turns the feature on at runtime', async () => {
  assert.equal((await alice.patch('/api/v1/instance/settings', { youtube: { cache_max_gb: -1 } })).body.error, 'invalid_youtube');
  assert.equal((await alice.patch('/api/v1/instance/settings', { youtube: { ytdlp_path: 5 } })).body.error, 'invalid_youtube');
  const s = await alice.patch('/api/v1/instance/settings', { youtube: { enabled: true, ytdlp_path: fake, cache_dir: path.join(dir, 'ytcache'), cache_max_gb: 0.1 } });
  assert.deepEqual(s.body.youtube, { enabled: true, ytdlp_path: fake, cache_dir: path.join(dir, 'ytcache'), cache_max_gb: 0.1 });
  await poll(async () => (await api(base).get('/.well-known/bonfire')).body.features.youtube === true);
  assert.equal(yt.enabled(), true);
  assert.equal(yt.version(), '2099.01.01');
});

test('video ids are validated: nothing odd ever reaches yt-dlp', async () => {
  const bad = ['abc', 'toolongvideoid1', 'aaaaaaaaaa;', '..%2F..%2Fetc%2Fpasswd', encodeURIComponent('a;touch /tmp/x'), encodeURIComponent('$(reboot)ab'), encodeURIComponent('abcdefghij\n'), '-----------x', encodeURIComponent('aaaaa aaaaa'), encodeURIComponent('é'.repeat(11))];
  for (const id of bad) {
    for (const [m, p] of [['post', 'prepare'], ['get', 'status'], ['post', 'save']]) {
      const r = m === 'get' ? await alice.get(`/api/v1/yt/${id}/${p}`) : await alice.post(`/api/v1/yt/${id}/${p}`);
      assert.deepEqual([r.status, r.body.error], [400, 'bad_video'], `${id} ${p}`);
    }
  }
  assert.equal(fs.existsSync(log), false, 'yt-dlp was never run');
  assert.equal(yt.validId('dQw4w9WgXcQ'), true); assert.equal(yt.validId('-_aA09bBcCd'), true); assert.equal(yt.validId('dQw4w9WgXc'), false);
  assert.equal((await api(base).post(`/api/v1/yt/${ID}/prepare`)).status, 401);
});

test('prepare -> status -> ready; the video streams through a signed link (Range, expiry, tampering)', async () => {
  const r = (await alice.post(`/api/v1/yt/${ID}/prepare`)).body;
  assert.ok(['queued', 'downloading'].includes(r.status), JSON.stringify(r));
  const st = (await poll(async () => { const d = (await alice.get(`/api/v1/yt/${ID}/status`)).body; return d.status === 'ready' ? d : null; }));
  assert.match(st.src, new RegExp(`^http://localhost:${inst.port}/api/v1/yt/stream/${ID}\\?e=\\d+&s=[A-Za-z0-9_-]{43}$`));
  assert.match(st.download, /&dl=1$/);
  // yt-dlp got an argument array: the id appears only inside the fixed URL, never as its own shell word
  const args = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]);
  assert.equal(args.at(-1), `https://www.youtube.com/watch?v=${ID}`);
  assert.ok(args.includes('--no-playlist') && args.includes('--max-filesize'));
  const at = u => u.replace(/^http:\/\/localhost:\d+/, base);
  const ok = await fetch(at(st.src));
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('content-type'), 'video/mp4'); assert.equal(ok.headers.get('accept-ranges'), 'bytes');
  assert.equal((await ok.arrayBuffer()).byteLength, 1000);
  const part = await fetch(at(st.src), { headers: { Range: 'bytes=10-19' } });
  assert.equal(part.status, 206); assert.equal(await part.text(), '0123456789'); assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000');
  assert.equal((await fetch(at(st.src), { headers: { Range: 'bytes=5000-' } })).status, 416);
  const dl = await fetch(at(st.download));
  assert.equal(dl.status, 200); assert.match(dl.headers.get('content-disposition'), /attachment; filename="youtube-dQw4w9WgXcQ\.mp4"/);
  // signature checks
  const u = new URL(st.src);
  const e = u.searchParams.get('e'), s = u.searchParams.get('s');
  const link = (id, ee, ss, extra = '') => `${base}/api/v1/yt/stream/${id}?e=${ee}&s=${ss}${extra}`;
  assert.equal(yt.verifyLink(ID, e, s, false), true);
  assert.equal(yt.verifyLink(ID, e, s, true), false); // a stream link can't be turned into a download
  assert.equal((await fetch(link(ID, e, s, '&dl=1'))).status, 403);
  assert.equal((await fetch(link(ID, e, s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A')))).status, 403); // tampered signature
  assert.equal((await fetch(link(ID, Number(e) + 1000, s))).status, 403); // extended expiry
  assert.equal((await fetch(link('aaaaaaaaaaa', e, s))).status, 403); // another video
  assert.equal((await fetch(`${base}/api/v1/yt/stream/${ID}`)).status, 403); // unsigned
  assert.equal((await fetch(link(ID, e, 'short'))).status, 403);
  const past = Date.now() - 1000;
  assert.equal((await fetch(link(ID, past, yt.sign(ID, past, false)))).status, 403); // correctly signed but expired
  assert.equal((await (await fetch(link(ID, past, yt.sign(ID, past, false)))).json()).error, 'link_expired');
  assert.equal(yt.verifyLink(ID, e, s, false), true);
  // a valid link for a video that is not in the cache
  const fut = Date.now() + 60000;
  const missing = await fetch(link('bbbbbbbbbbb', fut, yt.sign('bbbbbbbbbbb', fut, false)));
  assert.equal(missing.status, 404); assert.equal((await missing.json()).error, 'not_ready');
  // save: a copy as a regular upload attachment
  const saved = (await alice.post(`/api/v1/yt/${ID}/save`, { title: 'Never & Gonna: Give!' })).body;
  assert.equal(saved.status, 'saved');
  assert.deepEqual([saved.attachment.type, saved.attachment.size, saved.attachment.name], ['video', 1000, 'Never_Gonna_Give.mp4']);
  assert.match(saved.attachment.sha256, /^[0-9a-f]{64}$/);
  assert.equal((await fetch(at(saved.attachment.url))).status, 200);
});

test('cache cap evicts the least recently watched; at most 2 downloads run at once', async () => {
  const cache = yt.dir();
  const sparse = (id, ageMs) => { const f = path.join(cache, id + '.mp4'); fs.writeFileSync(f, ''); fs.truncateSync(f, 60 * 1024 * 1024); const t = new Date(Date.now() - ageMs); fs.utimesSync(f, t, t); return f; };
  const old = sparse('oldoldoldol', 3 * 3600e3), newer = sparse('newernewern', 1 * 3600e3); // 120 MB together, cap is 0.1 GB (~102 MB)
  process.env.FAKE_YT_MS = '700';
  const ids = ['ccccccccccc', 'ddddddddddd', 'eeeeeeeeeee'];
  for (const id of ids) await alice.post(`/api/v1/yt/${id}/prepare`);
  const states = await Promise.all(ids.map(async id => (await alice.get(`/api/v1/yt/${id}/status`)).body.status));
  assert.deepEqual(states.filter(s => s === 'downloading').length, 2);
  assert.deepEqual(states.filter(s => s === 'queued').length, 1);
  await poll(async () => (await Promise.all(ids.map(async id => (await alice.get(`/api/v1/yt/${id}/status`)).body.status))).every(s => s === 'ready'), 8000);
  assert.equal(fs.existsSync(old), false, 'oldest evicted');
  assert.equal(fs.existsSync(newer), true, 'newer kept');
  delete process.env.FAKE_YT_MS;
});

test('a binary that fails --version turns the feature off again', async () => {
  await alice.patch('/api/v1/instance/settings', { youtube: { ytdlp_path: '/bin/false' } });
  await poll(async () => !yt.enabled() || null).catch(() => {});
  // /bin/false --version exits 1 -> the feature turns itself off again
  assert.equal(yt.enabled(), false);
  assert.equal((await alice.post(`/api/v1/yt/${ID}/prepare`)).body.error, 'youtube_unavailable');
});
