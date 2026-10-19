#!/usr/bin/env node
'use strict';
// Local administrator tool: filesystem access to BONFIRE_DATA is the authority.
// Never starts the server, relays, bridges, or a gateway connection.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HELP = `Usage: node src/cli.js export <out.zip>
       node src/cli.js bot <command>
  create <username> [--avatar <url>] [--owner <principal>] [--description <text>]
  token <bot-id>
  add <bot-id> <community-sid> [--role <role-rid>]...
  role <bot-id> <community-sid> <role-rid> [--remove]
Uses BONFIRE_DATA (default ./data). The owner defaults to the instance owner.
Creates a private SQLite backup before every mutation. Tokens appear once on stdout.
Restart the server after mutations to refresh connected clients and revoke old gateways.
`;

function parse(args) {
  const [kind, command, ...rest] = args;
  if (kind !== 'bot' || !['create', 'token', 'add', 'role'].includes(command)) throw new Error(HELP);
  const positional = [], options = { roles: [] };
  const allowed = { create: ['--owner', '--avatar', '--description'], token: [], add: ['--role'], role: ['--remove'] }[command];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    if (!allowed.includes(arg)) throw new Error('Unknown option: ' + arg);
    if (arg === '--remove') { options.remove = true; continue; }
    const value = rest[++i];
    if (!value || value.startsWith('--')) throw new Error('Missing value for ' + arg);
    if (arg === '--role') options.roles.push(value);
    else {
      const key = arg.slice(2);
      if (options[key] !== undefined) throw new Error('Duplicate option: ' + arg);
      options[key] = value;
    }
  }
  if (positional.length !== { create: 1, token: 1, add: 2, role: 3 }[command]) throw new Error(HELP);
  if (options.avatar) {
    const url = new URL(options.avatar);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Avatar must be an HTTP(S) URL without credentials');
  }
  return { command, positional, options };
}

async function run(args, { out = s => process.stdout.write(s + '\n'), log = s => process.stderr.write(s + '\n') } = {}) {
  const { command, positional: p, options: o } = parse(args);
  const dir = path.resolve(process.env.BONFIRE_DATA || './data');
  const file = path.join(dir, 'bonfire.db');
  // Refuse a typo in BONFIRE_DATA instead of creating a new empty instance.
  if (!fs.existsSync(file) || !fs.existsSync(path.join(dir, 'config.json'))) throw new Error('Existing instance database and config.json required');
  const { DatabaseSync, backup } = require('node:sqlite');
  const backupDir = path.join(dir, 'cli-backups');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDir, 0o700);
  const destination = path.join(backupDir, `bonfire.db.bak-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`);
  // Reserve privately before SQLite opens it; backup includes committed WAL data.
  fs.closeSync(fs.openSync(destination, 'wx', 0o600));
  const source = new DatabaseSync(file, { readOnly: true });
  try { await backup(source, destination); } finally { source.close(); }
  fs.chmodSync(destination, 0o600);
  log('Database backup: ' + destination);
  const config = require('./config'), db = require('./db');
  config.init({ dataDir: dir });
  try {
    db.open();
    const auth = require('./auth'), bots = require('./bots'), C = require('./communities');
    const owner = o.owner ? auth.userByPrincipal(o.owner) : auth.ownerRow();
    const community = db.get('SELECT * FROM communities ORDER BY id LIMIT 1');
    const mayManage = owner && (auth.isAdmin(owner) || (community && C.snapOf(community).can(owner.id, require('./perms').P.MANAGE_SERVER)));
    if (!owner || owner.kind === 'bot' || owner.banned || !mayManage) throw new Error('Owner must be an existing, active instance administrator or community manager');
    const result = db.tx(() => {
      if (command === 'create') {
        const created = bots.create(owner, { name: p[0], description: o.description });
        if (o.avatar) db.run('UPDATE users SET pfp = ? WHERE principal = ?', o.avatar, created.bot.id);
        return { ...created, bot: { ...created.bot, pfp: o.avatar || null } };
      }
      const id = bots.parseId(p[0]);
      const bot = db.get('SELECT u.* FROM users u JOIN bots b ON b.user_id = u.id WHERE u.id = ?', id);
      if (!bot) throw new Error('Bot not found');
      if (command === 'token') return { id: bot.principal, ...bots.resetToken(owner, bot.principal) };
      const c = db.get('SELECT * FROM communities WHERE sid = ?', p[1]);
      if (!c) throw new Error('Community not found');
      if (!C.snapOf(c).can(owner.id, require('./perms').P.MANAGE_SERVER)) throw new Error('Owner cannot manage this community');
      if (db.get('SELECT 1 FROM bans WHERE community_id = ? AND user_id = ?', c.id, bot.id)) throw new Error('Bot is banned from this community');
      const refs = command === 'role' ? [p[2]] : o.roles;
      const roles = refs.map(rid => {
        const r = db.get('SELECT * FROM roles WHERE community_id = ? AND rid = ?', c.id, rid);
        if (!r || r.is_default) throw new Error('Role must be a non-default role in this community');
        return r;
      });
      if (command === 'add') C.addMember(c, bot.id, { quiet: true, announce: false });
      for (const r of roles) C.setMemberRole(c.sid, owner, bot.principal, r.rid, !o.remove);
      if (!db.get('SELECT 1 FROM members WHERE community_id = ? AND user_id = ?', c.id, bot.id)) throw new Error('Bot is not a community member');
      return { id: bot.principal, community: c.sid, roles: db.all('SELECT r.rid FROM roles r JOIN member_roles m ON m.role_id = r.id WHERE m.community_id = ? AND m.user_id = ?', c.id, bot.id).map(r => r.rid) };
    });
    log('Restart the instance server after CLI changes; token rotation cannot close gateways in another process.');
    out(JSON.stringify(result));
    return result;
  } finally { db.close(); }
}

// Keep the existing bonfire-hostd export command and its exit codes intact.
function main(argv) {
  const [cmd, out] = argv;
  if (cmd !== 'export' || !out) { console.error(HELP); return 2; }
  const config = require('./config'), db = require('./db');
  config.init({});
  db.open();
  try {
    const zip = require('./export').exportForBackup();
    if (!zip) { console.error('nothing to export: no community yet'); return 3; }
    fs.writeFileSync(out, zip, { mode: 0o600 });
    console.log(JSON.stringify({ ok: true, size: zip.length }));
    return 0;
  } finally { db.close(); }
}

if (require.main === module) {
  if (process.argv.includes('--help')) process.stdout.write(HELP);
  else if (process.argv[2] !== 'bot') {
    try { process.exitCode = main(process.argv.slice(2)); }
    catch (e) { console.error('export failed:', e.message); process.exitCode = 1; }
  }
  else run(process.argv.slice(2)).catch(() => {
    // Do not echo arbitrary database values / exception strings into logs.
    process.stderr.write('Bot command failed. Check arguments, owner permissions and instance data. Use --help for usage.\n');
    process.exitCode = 1;
  });
}
module.exports = { main, run, parse };
