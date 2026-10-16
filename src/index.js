#!/usr/bin/env node
'use strict';
// bonfire-server boot: config -> database -> claim code -> http + gateway.
const http = require('http');
const config = require('./config');
const db = require('./db');
const { App } = require('./http');
const { log } = require('./util');
const pkg = require('../package.json');

async function startServer({ dataDir, port, host = '0.0.0.0', restart } = {}) {
  config.init({ dataDir, port: port === undefined ? undefined : port || undefined });
  db.open();
  require('./communities'); // wires the auto_join hook
  const setup = require('./setup');
  const gateway = require('./gateway');
  const uploads = require('./uploads');
  setup.boot();
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

  const server = http.createServer((req, res) => { app.handle(req, res); });
  server.requestTimeout = 0; // large uploads
  gateway.attach(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port === undefined ? config.port() : port, host, resolve); });
  const actual = server.address().port;
  config.setPort(actual);
  log(`bonfire-server ${pkg.version} listening on ${host}:${actual}`);
  log(`  public url: ${config.get().public_url}   accounts: ${config.mode()}${config.mode() === 'velora' ? ` (${config.get().velora_url})` : ''}   data: ${config.dir()}`);

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    gateway.shutdown(1001, 'shutdown');
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
