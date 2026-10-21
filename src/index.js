#!/usr/bin/env node
'use strict';
// bonfire-server boot: config -> database -> claim code -> http + gateway.
const http = require('http');
const config = require('./config');
const db = require('./db');
const { App } = require('./http');
const { log } = require('./util');
const pkg = require('../package.json');

async function startServer({ dataDir, port, host = process.env.BONFIRE_HOST, restart } = {}) {
  config.init({ dataDir, port: port === undefined ? undefined : port || undefined });
  db.open();
  require('./communities').syncFromConfig(); // config.json is the source of truth for name/description/icon
  const setup = require('./setup');
  const gateway = require('./gateway');
  const uploads = require('./uploads');
  setup.boot();
  require('./export').importOnBoot(); // a restored backup (BONFIRE_IMPORT_ON_BOOT)
  config.watch();

  const app = new App({ trustProxy: process.env.BONFIRE_TRUST_PROXY === '1' });
  app.fallback((req, res, pathname) => (pathname.startsWith('/uploads/') && (req.method === 'GET' || req.method === 'HEAD') ? uploads.serve(req, res) : false));
  const doRestart = restart || (() => {
    gateway.broadcastAll({ type: 'instance_restarting' });
    gateway.closeAll(4010, 'instance_restarting');
    setTimeout(() => process.exit(75), 300);
  });
  require('./routes/instance').register(app, { restart: doRestart });
  require('./routes/chat').register(app);
  require('./routes/messages').register(app);
  require('./routes/extras').register(app);
  require('./routes/moderation').register(app); // server settings, reports, timeouts, audit log, dashboard
  require('./routes/hooks').register(app);
  require('./routes/botapi').register(app);
  require('./bridge').register(app); // Discord / Fluxer / CloudLink bridges (PROTOCOL §16, §17)
  require('./game').register(app);   // Bonfire Link / Minecraft (PROTOCOL §18)
  await require('./youtube').init(); // optional yt-dlp player: detects the binary

  const server = http.createServer((req, res) => { app.handle(req, res); });
  server.requestTimeout = 0; // large uploads
  gateway.attach(server);
  const listen = h => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port === undefined ? config.port() : port, h, resolve); });
  // default: '::' = IPv4 and IPv6, so "localhost" works everywhere (Windows tries ::1 first); IPv4 only if the host has no IPv6
  if (host) await listen(host);
  else {
    try { await listen(host = '::'); }
    catch (e) { if (!['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(e.code)) throw e; await listen(host = '0.0.0.0'); }
  }
  const actual = server.address().port;
  config.setPort(actual);
  require('./bridge').init(); // bridge tables, message hooks, the owner's bot gateways, CloudLink sockets
  require('./game').init();   // Bonfire Link tables, hooks, retention
  require('./profiles').start(); // keeps Velora members' names / pictures current
  require('./relay').start(); // Velora relays (PROTOCOL §12): registers in the background once we are reachable
  require('./audit').start(); // drops audit log entries past their retention, hourly
  uploads.startExpiry(); // deletes uploads past their expiry, every few minutes
  log(`bonfire-server ${pkg.version} listening on ${host}:${actual}`);
  log(`  public url: ${config.get().public_url}   accounts: ${config.mode()}${config.mode() === 'velora' ? ` (${config.get().velora_url})` : ''}   data: ${config.dir()}`);

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    require('./profiles').stop();
    require('./relay').stop();
    require('./audit').stop();
    uploads.stopExpiry();
    require('./bridge').shutdown();
    require('./game').shutdown();
    gateway.shutdown(1001, 'shutdown');
    require('./youtube').shutdown();
    config.unwatch();
    await new Promise(r => { server.close(() => r()); server.closeAllConnections?.(); });
    db.close();
  }
  return { server, port: actual, url: `http://127.0.0.1:${actual}`, close, setup, app };
}

if (require.main === module) {
  startServer({ port: undefined }).then(inst => {
    const stop = async sig => {
      log(`${sig} received, shutting down`);
      setTimeout(() => process.exit(1), 8000).unref();
      await inst.close();
      process.exit(0);
    };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));
  }).catch(e => { console.error('fatal:', e); process.exit(1); });
}

module.exports = { startServer };
