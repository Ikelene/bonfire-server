'use strict';
// Portable instance backups; deliberately independent of Velora relays and managed plans.
const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const auth = require('./auth');
const C = require('./communities');
const exp = require('./export');
const uploads = require('./uploads');
const gateway = require('./gateway');
const { err, randHex, now, clean } = require('./util');
const dir = () => path.join(config.dir(), 'backups');
const view = r => ({ id: r.id, created_at: r.created_at, size: r.size, by: r.by_principal, note: r.note });
const list = () => db.all('SELECT * FROM instance_backups ORDER BY created_at DESC, rowid DESC');
const file = id => path.join(dir(), id + '.zip');
function find(id) {
  if (!/^[a-f0-9]{32}$/.test(id || '')) throw err('backup_not_found', 404);
  const r = db.get('SELECT * FROM instance_backups WHERE id = ?', id);
  if (!r || !fs.existsSync(file(id))) throw err('backup_not_found', 404);
  return r;
}
function remove(r) {
  fs.rmSync(file(r.id), { force: true });
  db.run('DELETE FROM instance_backups WHERE id = ?', r.id);
}
function prune() { for (const r of list().slice(config.get().max_backups)) remove(r); }
function create(me, note = '') {
  if (typeof note !== 'string' || note.length > 300) throw err('invalid_note');
  const zip = exp.exportForBackup();
  if (!zip) throw err('no_community', 409);
  const r = { id: randHex(16), created_at: now(), size: zip.length, by_principal: me.principal, note: clean(note, 300) };
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file(r.id) + '.tmp', zip, { mode: 0o600 });
    fs.renameSync(file(r.id) + '.tmp', file(r.id));
    db.run('INSERT INTO instance_backups (id, created_at, size, by_principal, note) VALUES (?, ?, ?, ?, ?)', r.id, r.created_at, r.size, r.by_principal, r.note);
  } catch (e) { fs.rmSync(file(r.id) + '.tmp', { force: true }); fs.rmSync(file(r.id), { force: true }); throw e; }
  prune();
  return view(r);
}
function restore(me, buffer) {
  const parsed = exp.readExport(buffer); // validate before changing anything
  const current = db.get('SELECT * FROM communities ORDER BY id LIMIT 1');
  if (current) create(me, 'before restore');
  const afterCommit = [];
  let c;
  try {
    c = db.tx(() => {
      if (current) C.deleteCommunity(current.sid, me, { afterCommit });
      return exp.importCommunity(auth.ownerRow(), buffer, parsed);
    });
  } catch (e) { if (current) C.mirrorToConfig(current); throw e; }
  afterCommit.forEach(fn => fn());
  gateway.broadcastAll({ type: 'instance_restarting' });
  gateway.closeAll(4010, 'community restored'); // refresh memberships, roles and channels on reconnect
  return { ok: true, sid: c.sid };
}
function register(app) {
  const base = '/api/v1/instance/backups';
  app.get(base, { admin: true }, () => ({ backups: list().map(view) }));
  app.post(base, { admin: true }, req => ({ backup: create(req.user, req.body?.note) }));
  app.get(base + '/:id/download', { admin: true }, (req, res) => {
    const r = find(req.params.id);
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${r.id}.zip"`, 'Content-Length': r.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(file(r.id)).on('error', () => res.destroy()).pipe(res);
  });
  app.delete(base + '/:id', { admin: true }, req => { remove(find(req.params.id)); return { ok: true }; });
  app.post(base + '/:id/restore', { owner: true }, req => restore(req.user, fs.readFileSync(file(find(req.params.id).id))));
  app.post('/api/v1/instance/restore', { owner: true }, async req => {
    const { buffer } = await uploads.readMultipart(req, { maxBytes: 500 * 1024 * 1024 });
    if (!buffer?.length) throw err('no_file');
    return restore(req.user, buffer);
  });
}
module.exports = { register, create, restore, prune };
