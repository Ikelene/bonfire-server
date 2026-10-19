'use strict';
// A tiny router: CORS on everything, JSON bodies, {error} responses, bearer-session auth.
const auth = require('./auth');
const { err } = require('./util');
const managed = require('./managed');

const MAX_JSON = 1024 * 1024;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Device-Fingerprint',
  'Access-Control-Max-Age': '86400',
};

class App {
  constructor({ trustProxy = false } = {}) { this.routes = []; this.trustProxy = trustProxy; this.fallbacks = []; }
  add(method, pattern, opts, fn) {
    if (typeof opts === 'function') { fn = opts; opts = {}; }
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-z_]+)/gi, (m, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, opts: { auth: true, ...opts }, fn });
  }
  get(p, o, f) { this.add('GET', p, o, f); }
  post(p, o, f) { this.add('POST', p, o, f); }
  put(p, o, f) { this.add('PUT', p, o, f); }
  patch(p, o, f) { this.add('PATCH', p, o, f); }
  delete(p, o, f) { this.add('DELETE', p, o, f); }
  // fn(req, res) -> true when it answered (static files)
  fallback(fn) { this.fallbacks.push(fn); }

  ip(req) {
    if (this.trustProxy) { const x = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (x) return x; }
    return req.socket.remoteAddress || '?';
  }

  async handle(req, res) {
    for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { return this.send(res, 400, { error: 'bad_request' }); }
    const pathname = url.pathname;
    try {
      for (const fb of this.fallbacks) if (fb(req, res, pathname)) return;
      let matched = false;
      for (const r of this.routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        matched = true;
        if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
        // read-only mode (PROTOCOL §19.5): nothing but reading, signing in and the owner's export (a GET) gets through
        if (managed.readOnly() && req.method !== 'GET' && req.method !== 'HEAD' && !pathname.startsWith('/api/v1/auth/')) throw err('read_only', 403);
        req.params = {}; r.keys.forEach((k, i) => { try { req.params[k] = decodeURIComponent(m[i + 1]); } catch { req.params[k] = m[i + 1]; } });
        req.query = Object.fromEntries(url.searchParams);
        req.ip = this.ip(req);
        if (r.opts.auth) {
          const s = auth.resolveSession(auth.bearer(req));
          if (!s) throw err('invalid_session', 401);
          if (s.user.banned) throw err('banned', 403);
          req.user = s.user; req.session = s; req.scopes = s.scopes;
          if (r.opts.admin && !auth.isAdmin(s.user)) throw err('not_allowed', 403);
          if (r.opts.owner && !auth.isOwner(s.user)) throw err('owner_only', 403);
        }
        req.body = {};
        if (!/^multipart\//i.test(req.headers['content-type'] || '') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) req.body = await readJson(req);
        const out = await r.fn(req, res);
        if (!res.headersSent && !res.writableEnded) this.send(res, 200, out === undefined ? { ok: true } : out);
        return;
      }
      this.send(res, matched ? 405 : 404, { error: matched ? 'method_not_allowed' : 'not_found' });
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      if (!e.code) console.error('[http]', req.method, pathname, e.stack || e.message);
      this.send(res, e.status || (e.code ? 400 : 500), { error: e.code || 'server_error', ...(e.extra || {}) });
    }
  }
  send(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    res.end(body);
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = req.headers['content-type'] || '';
    const chunks = []; let n = 0, dead = false;
    req.on('data', d => { n += d.length; if (n > MAX_JSON) { dead = true; reject(err('payload_too_large', 413)); req.destroy(); } else chunks.push(d); });
    req.on('end', () => {
      if (dead) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      if (!/json/i.test(type)) return resolve({});
      try { const v = JSON.parse(text); resolve(v && typeof v === 'object' ? v : {}); } catch { reject(err('invalid_json', 400)); }
    });
    req.on('error', () => reject(err('bad_request', 400)));
  });
}

module.exports = { App, CORS };
