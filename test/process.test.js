'use strict';
// The real binary: setup code on stdout, claim, restart (exit 75), graceful SIGTERM (exit 0).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { tmpDir, api } = require('./helpers');

function boot(dir, port) {
  const child = spawn(process.execPath, [path.join(__dirname, '../src/index.js')], { env: { ...process.env, BONFIRE_DATA: dir, PORT: String(port), BONFIRE_ACCOUNTS_MODE: 'local', BONFIRE_PUBLIC_URL: '', BONFIRE_OWNER: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const exited = new Promise(res => child.on('exit', (code, signal) => res({ code, signal })));
  const ready = new Promise((res, rej) => { child.stdout.on('data', d => { out += d; if (/listening on/.test(out)) res(); }); setTimeout(() => rej(new Error('did not start: ' + out)), 8000); });
  return { child, ready, exited, out: () => out };
}

test('bonfire-server binary: setup code, restart exit code 75, SIGTERM exit 0', async () => {
  const dir = tmpDir();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  const p = boot(dir, port);
  await p.ready;
  const code = /\b([0-9A-Z]{4}-[0-9A-Z]{4})\b/.exec(p.out())?.[1];
  assert.ok(code, 'setup code printed to stdout: ' + p.out());
  assert.equal(fs.readFileSync(path.join(dir, 'setup-code.txt'), 'utf8').trim(), code);
  const reg = await api(base).post('/api/v1/auth/register', { username: 'owner1', password: 'password123' });
  const a = api(base, reg.body.session);
  assert.equal((await a.post('/api/v1/instance/claim', { code })).status, 200);
  await a.post('/api/v1/servers', { name: 'persists' });
  assert.equal((await a.post('/api/v1/instance/restart')).status, 202);
  assert.deepEqual(await p.exited, { code: 75, signal: null });

  // state survives the restart; a claimed instance prints no code
  const p2 = boot(dir, port);
  await p2.ready;
  assert.doesNotMatch(p2.out(), /not claimed/);
  const login = await api(base).post('/api/v1/auth/login', { username: 'owner1', password: 'password123' });
  assert.equal(login.status, 200);
  assert.equal((await api(base, login.body.session).get('/api/v1/servers')).body.servers[0].name, 'persists');
  p2.child.kill('SIGTERM');
  assert.deepEqual(await p2.exited, { code: 0, signal: null });
  fs.rmSync(dir, { recursive: true, force: true });
});
