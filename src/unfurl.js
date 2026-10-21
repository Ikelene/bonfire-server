'use strict';
// Link previews made on the server: the browser never visits the linked site. Ported from Velora's unfurl.js, with strict SSRF rules:
//  - only http / https, only ports 80 and 443, no user:pass@
//  - the host is resolved here; if ANY address is private / loopback / link-local / metadata / reserved (IPv4 and IPv6, incl.
//    IPv4-mapped, NAT64 and 6to4 forms) the fetch is refused, and the connection is then pinned to the address we checked (no rebinding)
//  - redirects are followed by hand (max 3) and every hop is validated again, DNS included
//  - 1 MB for pages, 5 MB for pictures, 7 s per hop / 10 s total, no cookies, no decompression
// Preview pictures are re-hosted in DATA_DIR/uploads/embeds (viewers never load them from the site). Results are cached in SQLite.
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const uploads = require('./uploads');
const { sha256, now, normalizeOrigin } = require('./util');

const UA = 'Mozilla/5.0 (compatible; BonfireBot/1.0) facebookexternalhit/1.1';
const TTL = 24 * 3600 * 1000, FAIL_TTL = 3600 * 1000;
const MAX_REDIRECTS = 3, HOP_MS = 7000, TOTAL_MS = 10000;

// ---- address rules ----
const priv4 = ([a, b, c]) => a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
  || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113);
function v6bytes(ip) {
  ip = ip.toLowerCase().split('%')[0];
  const m = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (m) { const p = m.slice(2).map(Number); if (p.some(n => n > 255)) return null; ip = m[1] + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16); }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const part = s => (s ? s.split(':') : []);
  const head = part(halves[0]), rest = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 0 : fill !== 0) return null;
  const groups = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...rest];
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const b = Buffer.alloc(16);
  groups.forEach((g, i) => b.writeUInt16BE(parseInt(g, 16), i * 2));
  return b;
}
function isPrivateIp(ip) {
  ip = String(ip).replace(/^\[|\]$/g, '');
  if (net.isIPv4(ip)) return priv4(ip.split('.').map(Number));
  if (!net.isIPv6(ip)) return true; // not an address we understand: refuse
  const b = v6bytes(ip);
  if (!b) return true;
  if (b.subarray(0, 10).every(x => x === 0)) { // ::/96 and ::ffff:0:0/96
    if (b[10] === 0xff && b[11] === 0xff) return priv4([...b.subarray(12, 16)]); // IPv4-mapped: judge the IPv4 inside
    return true; // ::, ::1, deprecated IPv4-compatible
  }
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return b.subarray(4, 12).every(x => x === 0) ? priv4([...b.subarray(12, 16)]) : true; // NAT64
  if ((b[0] & 0xe0) !== 0x20) return true; // only global unicast 2000::/3 is allowed (drops ULA, link-local, site-local, multicast, discard ...)
  if (b[0] === 0x20 && b[1] === 0x02) return priv4([...b.subarray(2, 5)]); // 6to4: the embedded IPv4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true; // Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation
  return false;
}

// ---- seams for tests (never used in production) ----
let resolver = host => dns.promises.lookup(host, { all: true, verbatim: true });
let privateCheck = isPrivateIp;
let anyPort = false;
const _test = { set(o) { if (o.resolver) resolver = o.resolver; if (o.isPrivate) privateCheck = o.isPrivate; if (o.anyPort !== undefined) anyPort = o.anyPort; }, reset() { resolver = host => dns.promises.lookup(host, { all: true, verbatim: true }); privateCheck = isPrivateIp; anyPort = false; } };

const refuse = () => Object.assign(new Error('private_address'), { code: 'EPRIVATE' });
function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw Object.assign(new Error('bad_url'), { code: 'EBADURL' }); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (!anyPort && u.port && !['80', '443'].includes(u.port)) || raw.length > 2000) throw Object.assign(new Error('bad_url'), { code: 'EBADURL' });
  return u;
}
// -> the one address we will connect to; throws if any address the name resolves to is not public
async function pick(host) {
  const lit = host.replace(/^\[|\]$/g, '');
  const list = net.isIP(lit) ? [{ address: lit, family: net.isIPv6(lit) ? 6 : 4 }] : await resolver(lit);
  if (!list?.length || list.some(x => privateCheck(x.address))) throw refuse();
  return list[0];
}
function hop(u, addr, { maxBytes, accept }) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined, path: u.pathname + u.search, method: 'GET', timeout: HOP_MS,
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en', Host: u.host, 'Accept-Encoding': 'identity' },
      lookup: (h, o, cb) => (o && o.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)), // pinned to the checked address
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve({ redirect: res.headers.location }); }
      const chunks = []; let size = 0, done = false;
      const finish = cut => { if (done) return; done = true; resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).subarray(0, maxBytes), cut }); };
      res.on('data', d => { size += d.length; chunks.push(d); if (size > maxBytes) { finish(true); req.destroy(); } });
      res.on('end', () => finish(false));
      res.on('error', e => { if (!done) reject(e); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
async function fetchSafe(url, { maxBytes = 1024 * 1024, accept = 'text/html,application/xhtml+xml,application/json;q=0.9,image/*;q=0.8,*/*;q=0.5' } = {}) {
  const deadline = Date.now() + TOTAL_MS;
  let next = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const u = checkUrl(next);
    const addr = await pick(u.hostname);
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('timeout');
    let timer;
    const r = await Promise.race([hop(u, addr, { maxBytes, accept }), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), left); })]).finally(() => clearTimeout(timer));
    if (r.redirect) { try { next = new URL(r.redirect, u).href; } catch { throw Object.assign(new Error('bad_url'), { code: 'EBADURL' }); } continue; }
    return { ...r, url: u.href };
  }
  throw new Error('too_many_redirects');
}

// Server settings > Message rules > Preview proxy URL: pages and pictures for previews are fetched through it. `{url}` in the proxy
// address is replaced by the (encoded) link; without it the link goes in its `url` query parameter. The proxy itself must be public.
function proxied(proxy, url) {
  if (!proxy) return url;
  if (proxy.includes('{url}')) return proxy.replace('{url}', encodeURIComponent(url));
  const p = new URL(proxy);
  p.searchParams.set('url', url);
  return p.href;
}
const fetchVia = proxy => (url, opts) => fetchSafe(proxied(proxy, url), opts);

// ---- reading a page ----
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = s => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
}).replace(/\s+/g, ' ').trim();
function readMeta(html, base) {
  const head = html.slice(0, 300000), meta = {};
  for (const tag of head.match(/<meta\s[^>]*>/gi) || []) {
    const attr = n => (new RegExp(`${n}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag) || []).slice(2).find(x => x != null);
    const key = (attr('property') || attr('name') || attr('itemprop') || '').toLowerCase(), val = attr('content');
    if (key && val != null && meta[key] == null) meta[key] = decode(val);
  }
  const title = meta['og:title'] || meta['twitter:title'] || decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head) || [])[1]);
  const abs = v => { try { return v ? new URL(v, base).href : null; } catch { return null; } };
  let oembed = null; // <link rel="alternate" type="application/json+oembed" href="...">
  for (const tag of head.match(/<link\s[^>]*>/gi) || []) if (/json\+oembed/i.test(tag)) { const h = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag); if (h) { oembed = abs(decode(h[2] ?? h[3])); break; } }
  return {
    site: (meta['og:site_name'] || '').slice(0, 100) || new URL(base).hostname.replace(/^www\./, ''),
    title: (title || '').slice(0, 256),
    description: (meta['og:description'] || meta['twitter:description'] || meta.description || '').slice(0, 350),
    image: abs(meta['og:image:secure_url'] || meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src']),
    large: (meta['twitter:card'] || '') === 'summary_large_image',
    color: /^#[0-9a-f]{6}$/i.test(meta['theme-color'] || '') ? parseInt(meta['theme-color'].slice(1), 16) : undefined,
    oembed,
  };
}
async function readOembed(endpoint, get = fetchSafe) {
  try {
    const r = await get(endpoint, { maxBytes: 256 * 1024, accept: 'application/json' });
    if (r.status !== 200) return null;
    const j = JSON.parse(r.body.toString('utf8'));
    return { site: String(j.provider_name || '').slice(0, 100), title: String(j.title || '').slice(0, 256), description: String(j.author_name || '').slice(0, 350), image: typeof j.thumbnail_url === 'string' ? j.thumbnail_url : null };
  } catch { return null; }
}
// the preview picture lives on this instance, so viewers never load it from the site
async function hostImage(url, get = fetchSafe) {
  if (!url) return null;
  try {
    const base = sha256(url).slice(0, 40);
    const dir = path.join(uploads.root(), 'embeds');
    const have = fs.existsSync(dir) && fs.readdirSync(dir).find(f => f.startsWith(base + '.'));
    let buf, ext;
    if (have) { buf = fs.readFileSync(path.join(dir, have)); ext = have.split('.').pop(); }
    else {
      const r = await get(url, { maxBytes: 5 * 1024 * 1024, accept: 'image/*' });
      const sn = r.status === 200 && !r.cut ? uploads.sniff(r.body) : null;
      if (!sn || !['image', 'gif'].includes(sn.type)) return null;
      ext = sn.ext; buf = ext === 'jpg' ? uploads.stripJpegExif(r.body) : r.body;
      uploads.writeStored(`embeds/${base}.${ext}`, buf);
    }
    const d = uploads.dimensions(buf, ext);
    return { url: `${normalizeOrigin(config.publicUrl())}/uploads/embeds/${base}.${ext}`, width: d.width || 0, height: d.height || 0 };
  } catch { return null; }
}

// ---- YouTube (title + channel + thumbnail, for the client's own player) ----
const YT = /^(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i;
const youtubeId = url => (YT.exec(url) || [])[1] || null;
async function youtube(id, url, get = fetchSafe) {
  let title = '', channel = '';
  try {
    const r = await get(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, { maxBytes: 64 * 1024 });
    if (r.status === 200) { const j = JSON.parse(r.body.toString()); title = j.title || ''; channel = j.author_name || ''; }
  } catch { /* still show the player */ }
  const image = await hostImage(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, get);
  return { type: 'youtube', id, url, title: title.slice(0, 256), channel: channel.slice(0, 100), image: image?.url || null };
}

// ---- entry point: -> embed | null ----
const inflight = new Map();
async function unfurl(rawUrl, { proxy = '' } = {}) {
  let u;
  try { u = checkUrl(String(rawUrl || '').trim()); } catch { return null; }
  const hash = sha256(u.href).slice(0, 40);
  const hit = db.get('SELECT data, created_at FROM unfurls WHERE url_hash = ?', hash);
  if (hit && now() - hit.created_at < (hit.data ? TTL : FAIL_TTL)) return hit.data ? JSON.parse(hit.data) : null;
  if (inflight.has(hash)) return inflight.get(hash);
  const job = (async () => {
    let data = null;
    const get = fetchVia(proxy);
    try {
      const yid = youtubeId(u.href);
      if (yid) data = await youtube(yid, u.href, get);
      else {
        const r = await get(u.href);
        if (r.status === 200 && /html/i.test(r.headers['content-type'] || '')) {
          const m = readMeta(r.body.toString('utf8'), proxy ? u.href : r.url);
          if (!m.title && !m.description && !m.image && m.oembed) Object.assign(m, await readOembed(m.oembed, get) || {});
          if (m.title || m.description || m.image) {
            const img = await hostImage(m.image, get);
            data = { type: 'link', url: u.href, site: m.site, title: m.title, description: m.description, color: m.color, image: img?.url || null, large: !!img && (m.large || (img.width >= 400 && img.width > img.height * 1.3)) };
          }
        }
      }
    } catch { data = null; }
    try { db.run('INSERT INTO unfurls (url_hash, url, data, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(url_hash) DO UPDATE SET data = excluded.data, created_at = excluded.created_at', hash, u.href.slice(0, 1000), data ? JSON.stringify(data) : null, now()); } catch { /* db closed */ }
    return data;
  })();
  inflight.set(hash, job);
  try { return await job; } finally { inflight.delete(hash); }
}

module.exports = { unfurl, fetchSafe, proxied, isPrivateIp, youtubeId, _test };
