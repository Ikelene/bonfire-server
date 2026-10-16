'use strict';
// Discovery, instance auth, claiming, instance settings + admins.
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const setup = require('../setup');
const gateway = require('../gateway');
const C = require('../communities');
const { err, limiter, log } = require('../util');
const pkg = require('../../package.json');

const registerLimit = limiter(10, 3600 * 1000);
const loginLimit = limiter(20, 600 * 1000);
const veloraLimit = limiter(60, 60 * 1000);
const claimLimit = limiter(10, 600 * 1000);

function discovery() {
  const cfg = config.get();
  const mode = config.mode();
  return {
    software: 'bonfire-server', version: pkg.version, protocol: 1,
    name: cfg.name, description: cfg.description, icon_url: cfg.icon_url, public_url: cfg.public_url,
    accounts_mode: mode,
    velora: mode === 'velora' ? { issuer: cfg.velora_url, jwks_url: `${cfg.velora_url}/.well-known/bonfire/jwks.json` } : null,
    claimed: auth.claimed(),
    registration: mode === 'local' && (cfg.registration === 'open' || !auth.claimed()) ? 'open' : 'closed',
    features: { signing: mode === 'velora', voice: config.voiceConfigured(), uploads: true, youtube: require('../youtube').enabled() },
    max_upload_mb: cfg.max_upload_mb,
    community: C.discoveryCommunity(),
  };
}

function register(app, { restart }) {
  app.get('/.well-known/bonfire', { auth: false }, () => discovery());
  app.get('/health', { auth: false }, () => ({ ok: true }));
  app.get('/', { auth: false }, () => ({ software: 'bonfire-server', version: pkg.version, protocol: 1, discovery: '/.well-known/bonfire' }));

  // ---- auth ----
  app.post('/api/v1/auth/velora', { auth: false }, async req => {
    if (!veloraLimit.hit(req.ip)) throw err('rate_limited', 429);
    return auth.loginVelora(req.body?.token);
  });
  app.post('/api/v1/auth/register', { auth: false }, async req => {
    if (!registerLimit.hit(req.ip)) throw err('rate_limited', 429);
    return auth.registerLocal(req.body?.username, req.body?.password);
  });
  app.post('/api/v1/auth/login', { auth: false }, async req => {
    if (!loginLimit.hit(req.ip)) throw err('rate_limited', 429);
    return auth.loginLocal(req.body?.username, req.body?.password);
  });
  app.post('/api/v1/auth/logout', req => { auth.revokeSession(auth.bearer(req)); return { ok: true }; });
  app.get('/api/v1/me', req => ({ user: auth.userView(req.user), instance_admin: auth.isAdmin(req.user), instance_owner: auth.isOwner(req.user), scopes: req.scopes }));

  // ---- claim + settings + admins ----
  app.post('/api/v1/instance/claim', req => {
    if (!claimLimit.hit(req.ip)) throw err('rate_limited', 429);
    if (auth.claimed()) throw err('already_claimed', 409);
    if (!setup.check(req.body?.code)) throw err('invalid_code', 403);
    setup.claim(req.user);
    gateway.pushToUser(req.user.id, { type: 'instance_update', settings: config.publicView() });
    return { ok: true };
  });
  app.get('/api/v1/instance/settings', { admin: true }, () => config.adminView());
  app.patch('/api/v1/instance/settings', { admin: true }, req => { config.update(req.body); return config.adminView(); });
  app.post('/api/v1/instance/restart', { admin: true }, (req, res) => {
    log(`[instance] restart requested by ${req.user.principal}`);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    setTimeout(restart, 100);
  });
  app.get('/api/v1/instance/admins', { admin: true }, () => ({
    admins: db.all('SELECT u.* FROM instance_admins a JOIN users u ON u.id = a.user_id ORDER BY u.id').map(auth.userView),
    owner: auth.userView(auth.ownerRow()),
  }));
  app.put('/api/v1/instance/admins/:uid', { owner: true }, req => {
    const u = C.userByPrincipalOrThrow(req.params.uid);
    db.run('INSERT OR IGNORE INTO instance_admins (user_id) VALUES (?)', u.id);
  });
  app.delete('/api/v1/instance/admins/:uid', { owner: true }, req => {
    const u = C.userByPrincipalOrThrow(req.params.uid);
    if (auth.isOwner(u)) throw err('cannot_remove_owner', 400);
    db.run('DELETE FROM instance_admins WHERE user_id = ?', u.id);
  });
}
module.exports = { register, discovery };
