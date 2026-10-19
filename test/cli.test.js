'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { tmpDir } = require('./helpers');
const { startServer } = require('../src/index');
const { parse } = require('../src/cli');
const db = require('../src/db');
const auth = require('../src/auth');
const C = require('../src/communities');
const { P } = require('../src/perms');
const { sha256 } = require('../src/util');
const WebSocket = require('ws');

test('CLI rejects malformed commands and unsafe avatar URLs', () => {
  for (const args of [[], ['bot', 'token'], ['bot', 'token', '1', '--owner', 'v:1'], ['bot', 'create', 'Mahi', '--avatar'], ['bot', 'create', 'Mahi', '--avatar', 'file:///tmp/a'], ['bot', 'create', 'Mahi', '--avatar', 'https://secret@example.test/a']]) assert.throws(() => parse(args));
});

test('CLI lifecycle: WAL-safe backup, hashed tokens, quiet membership, roles, REST and gateway authentication', async () => {
  const dir = tmpDir();
  process.env.BONFIRE_ACCOUNTS_MODE = 'velora';
  process.env.BONFIRE_OWNER = 'v:1';
  const inst = await startServer({ dataDir: dir, port: 0, host: '127.0.0.1' });
  let ws;
  const cli = async (...args) => {
    const r = await execFile(process.execPath, [path.resolve(__dirname, '../src/cli.js'), 'bot', ...args], { env: { ...process.env, BONFIRE_DATA: dir } });
    assert.match(r.stderr, /Database backup:/);
    return JSON.parse(r.stdout);
  };
  try {
    const owner = auth.userByPrincipal('v:1');
    const community = C.createCommunity(owner, { name: 'CLI fixture' });
    const c = db.get('SELECT * FROM communities WHERE sid = ?', community.sid);
    C.createChannel(c.sid, owner, { name: 'welcome', type: 'welcome' });
    const role = C.createRole(c.sid, owner, { name: 'Bot', permissions: P.SEND | P.MANAGE_MESSAGES });
    const before = db.get('SELECT COUNT(*) AS n FROM messages').n;
    const created = await cli('create', 'Mahi', '--owner', 'v:1', '--avatar', 'https://example.test/mahi.png');
    assert.equal(created.bot.owner, 'v:1');
    assert.equal(created.bot.pfp, 'https://example.test/mahi.png');
    const id = Number(created.bot.id.slice(2));
    assert.equal(db.get('SELECT token_hash FROM bots WHERE user_id = ?', id).token_hash, sha256(created.token));
    const backupDir = path.join(dir, 'cli-backups');
    const firstBackup = path.join(backupDir, fs.readdirSync(backupDir)[0]);
    const { DatabaseSync } = require('node:sqlite');
    const saved = new DatabaseSync(firstBackup, { readOnly: true });
    try {
      assert.equal(saved.prepare('SELECT COUNT(*) AS n FROM bots').get().n, 0);
      assert.equal(saved.prepare('SELECT name FROM communities WHERE sid = ?').get(c.sid).name, c.name);
    } finally { saved.close(); }
    if (process.platform !== 'win32') assert.equal(fs.statSync(firstBackup).mode & 0o777, 0o600);
    await assert.rejects(cli('add', created.bot.id, c.sid, '--role', 'rMissing'));
    assert.equal(db.get('SELECT COUNT(*) AS n FROM members WHERE user_id = ?', id).n, 0);
    const added = await cli('add', created.bot.id, c.sid, '--role', role.rid);
    assert.deepEqual(added.roles, [role.rid]);
    await cli('add', created.bot.id, c.sid, '--role', role.rid); // safe to retry
    assert.equal(C.snapOf(c).can(id, P.MANAGE_MESSAGES), true);
    await cli('role', created.bot.id, c.sid, role.rid, '--remove');
    assert.equal(C.snapOf(c).can(id, P.MANAGE_MESSAGES), false);
    await cli('role', created.bot.id, c.sid, role.rid);
    const rotated = await cli('token', created.bot.id);
    assert.notEqual(rotated.token, created.token);
    const request = token => fetch(inst.url + '/bot/v1/users/@me', { headers: { Authorization: 'Bot ' + token } });
    assert.equal((await request(created.token)).status, 401);
    assert.equal((await request(rotated.token)).status, 200);
    const guilds = await fetch(inst.url + '/bot/v1/users/@me/guilds', { headers: { Authorization: 'Bot ' + rotated.token } }).then(r => r.json());
    assert.equal(guilds[0].id, String(c.id));
    ws = new WebSocket(inst.url.replace(/^http/, 'ws') + '/bot/gateway');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CLI bot gateway authentication timeout')), 5000);
      ws.on('error', reject);
      let ready = false;
      ws.on('message', raw => {
        const f = JSON.parse(raw);
        if (f.op === 10) ws.send(JSON.stringify({ op: 2, d: { token: rotated.token } }));
        if (f.t === 'READY') { assert.equal(f.d.user.username, 'Mahi'); ready = true; }
        if (f.t === 'GUILD_CREATE') { assert.equal(ready, true); assert.equal(f.d.id, String(c.id)); clearTimeout(timer); resolve(); }
      });
    });
    assert.equal(db.get('SELECT COUNT(*) AS n FROM messages').n, before, 'no messages, including welcome notices');
    for (const filename of fs.readdirSync(backupDir)) {
      const bytes = fs.readFileSync(path.join(backupDir, filename));
      assert.equal(bytes.includes(Buffer.from(rotated.token)), false);
      assert.equal(bytes.includes(Buffer.from(created.token)), false);
    }
    await assert.rejects(cli('create', 'Mahi'));
    assert.equal(db.get('SELECT COUNT(*) AS n FROM bots').n, 1);
  } finally {
    ws?.terminate();
    await inst.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
