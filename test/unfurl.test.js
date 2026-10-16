'use strict';
// Link previews: strict SSRF refusal, redirect re-checks, limits, OpenGraph parsing, caching, session required.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const { startServer } = require('../src/index');
const { tmpDir, api } = require('./helpers');
const unfurl = require('../src/unfurl');

process.env.BONFIRE_ACCOUNTS_MODE = 'local';
delete process.env.BONFIRE_OWNER;
const dir = tmpDir();
let inst, alice, hits = {};
const REAL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test.before(async () => {
  inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1' });
  const r = await api(inst.url).post('/api/v1/auth/register', { username: 'alice', password: 'correct horse battery' });
  alice = api(inst.url, r.body.session);
});
test.after(async () => { unfurl._test.reset(); await inst.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const refused = async url => { await assert.rejects(unfurl.fetchSafe(url), e => e.code === 'EPRIVATE' || e.code === 'EBADURL', url); };

test('address classification: private, loopback, link-local, metadata, IPv6 and IPv4-mapped forms', () => {
  for (const ip of ['127.0.0.1', '127.8.8.8', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '169.254.0.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:192.168.0.1', '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '2002:a00:1::', '2001:db8::1', '2001:0:4136:e378::1', 'not-an-ip'])
    assert.equal(unfurl.isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '2002:808:808::1', '64:ff9b::808:808'])
    assert.equal(unfurl.isPrivateIp(ip), false, ip);
});

test('literal and named private hosts are refused before any connection', async () => {
  for (const u of ['http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://10.1.2.3/', 'http://169.254.169.254/latest/meta-data/', 'https://169.254.169.254/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:a9fe:a9fe]/', 'http://[fe80::1]/', 'http://[fd00::1]/', 'http://localhost/', 'http://0.0.0.0/', 'http://192.168.0.10/admin'])
    await refused(u);
  // protocol / port / credentials
  for (const u of ['file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/', 'http://example.com:8080/', 'https://example.com:22/', 'http://user:pass@example.com/', 'javascript:alert(1)', 'not a url']) await refused(u);
});

test('GET /unfurl needs a session and gives no preview for refused addresses', async () => {
  assert.equal((await api(inst.url).get('/api/v1/unfurl?url=https://example.com')).status, 401);
  for (const u of ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'ftp://example.com/x']) {
    const r = await alice.get('/api/v1/unfurl?url=' + encodeURIComponent(u));
    assert.equal(r.status, 200); assert.deepEqual(r.body, { embed: null }, u);
  }
  assert.equal((await alice.get('/api/v1/unfurl')).body.embed, null);
});

// ---- a local "public" site: the test resolver points every name at 127.0.0.1 and allows exactly that address (and any port) ----
test('fetching: redirects are re-checked, capped at 3, size limited; OpenGraph + oEmbed + picture re-hosting; cached', async () => {
  const site = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    const o = `http://public.test:${site.address().port}`;
    if (req.url === '/page') { res.setHeader('Content-Type', 'text/html'); return res.end(`<html><head><title>ignored</title><meta property="og:title" content="Hello &amp; welcome"><meta property="og:description" content="A page"><meta property="og:site_name" content="Test Site"><meta property="og:image" content="/pic.png"><meta name="theme-color" content="#ff8800"></head></html>`); }
    if (req.url === '/pic.png') { res.setHeader('Content-Type', 'image/png'); return res.end(REAL_PNG); }
    if (req.url === '/evil.png') { res.setHeader('Content-Type', 'image/png'); return res.end('<html>not an image</html>'); }
    if (req.url === '/bad-image') { res.setHeader('Content-Type', 'text/html'); return res.end('<meta property="og:title" content="T"><meta property="og:image" content="/evil.png">'); }
    if (req.url === '/oembed') { res.setHeader('Content-Type', 'text/html'); return res.end(`<html><head><link rel="alternate" type="application/json+oembed" href="/oembed.json"></head></html>`); }
    if (req.url === '/oembed.json') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ provider_name: 'Vid', title: 'Clip', author_name: 'someone' })); }
    const redirect = to => { res.writeHead(302, { Location: to }); res.end(); };
    if (req.url === '/to-metadata') return redirect('http://169.254.169.254/latest/meta-data/');
    if (req.url === '/to-loopback6') return redirect('http://[::1]/');
    if (req.url === '/to-mapped') return redirect('http://[::ffff:7f00:1]/');
    if (req.url === '/to-file') return redirect('file:///etc/passwd');
    if (req.url === '/to-port') return redirect('http://public.test:8080/');
    if (req.url === '/to-ten') return redirect('http://10.0.0.5/');
    if (req.url === '/hop') return redirect(o + '/page');
    const m = /^\/chain(\d)$/.exec(req.url);
    if (m) return redirect(Number(m[1]) <= 1 ? o + '/page' : o + '/chain' + (m[1] - 1));
    if (req.url === '/big') { res.setHeader('Content-Type', 'text/html'); return res.end(Buffer.alloc(3 * 1024 * 1024, 'a')); }
    res.statusCode = 404; res.end();
  });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  const base = `http://public.test:${site.address().port}`;
  unfurl._test.set({ resolver: async () => [{ address: '127.0.0.1', family: 4 }], isPrivate: ip => ip !== '127.0.0.1' && unfurl.isPrivateIp(ip), anyPort: true });
  try {
    assert.equal((await unfurl.fetchSafe(base + '/hop')).status, 200); // a redirect to a fine place is followed
    for (const p of ['/to-metadata', '/to-loopback6', '/to-mapped', '/to-ten']) await assert.rejects(unfurl.fetchSafe(base + p), e => e.code === 'EPRIVATE', p);
    for (const p of ['/to-file']) await assert.rejects(unfurl.fetchSafe(base + p), e => e.code === 'EBADURL', p);
    assert.equal((await unfurl.fetchSafe(base + '/chain3')).status, 200); // 3 redirects are fine
    await assert.rejects(unfurl.fetchSafe(base + '/chain4'), /too_many_redirects/);
    const big = await unfurl.fetchSafe(base + '/big');
    assert.equal(big.cut, true); assert.ok(big.body.length <= 1024 * 1024);
    // the redirect hop to a private address never reaches the network: the site only saw its own requests
    assert.equal(hits['/'], undefined);

    // OpenGraph + the picture is re-hosted on this instance
    const e = await unfurl.unfurl(base + '/page');
    assert.deepEqual([e.type, e.title, e.description, e.site, e.color], ['link', 'Hello & welcome', 'A page', 'Test Site', 0xff8800]);
    assert.match(e.image, new RegExp(`^http://localhost:${inst.port}/uploads/embeds/[0-9a-f]{40}\\.png$`));
    assert.equal((await fetch(e.image.replace(/^http:\/\/localhost:\d+/, inst.url))).status, 200);
    const before = hits['/page'];
    assert.deepEqual(await unfurl.unfurl(base + '/page'), e); // cached in SQLite
    assert.equal(hits['/page'], before);
    assert.equal((await alice.get('/api/v1/unfurl?url=' + encodeURIComponent(base + '/page'))).body.embed.title, 'Hello & welcome');
    // a "picture" that is not one is dropped, the text preview stays
    const bad = await unfurl.unfurl(base + '/bad-image');
    assert.deepEqual([bad.title, bad.image], ['T', null]);
    // oEmbed discovery when the page has no OpenGraph
    const oe = await unfurl.unfurl(base + '/oembed');
    assert.deepEqual([oe.title, oe.site, oe.description], ['Clip', 'Vid', 'someone']);
    // a refused redirect gives no preview at all
    assert.equal(await unfurl.unfurl(base + '/to-metadata'), null);
    assert.equal(await unfurl.unfurl(base + '/missing'), null);
  } finally { unfurl._test.reset(); await new Promise(r => site.close(r)); site.closeAllConnections?.(); }
});

test('with the real resolver a name that points at a private address is refused', async () => {
  unfurl._test.reset();
  unfurl._test.set({ resolver: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }] }); // one bad address poisons the name
  await refused('https://mixed.example/');
  unfurl._test.set({ resolver: async () => [{ address: '::ffff:127.0.0.1', family: 6 }] });
  await refused('https://mapped.example/');
  unfurl._test.set({ resolver: async () => [] });
  await refused('https://nothing.example/');
  unfurl._test.reset();
});
