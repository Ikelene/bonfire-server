'use strict';
// Uploads (PROTOCOL §11): magic-byte type detection, JPEG EXIF strip, hashing, storage under DATA_DIR/uploads, serving.
const fs = require('fs');
const path = require('path');
const Busboy = require('busboy');
const config = require('./config');
const db = require('./db');
const { err, sha256, randHex, now, clean, normalizeOrigin } = require('./util');

const root = () => path.join(config.dir(), 'uploads');
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac',
};
const MEDIA_EXT = new Set(Object.keys(MIME));

// -> { ext, mime, type } by looking at the bytes (never at the client's claims); null = unknown
function sniff(b) {
  const at = (o, s) => b.length >= o + s.length && b.subarray(o, o + s.length).equals(Buffer.from(s, 'latin1'));
  if (b.length >= 8 && b[0] === 0x89 && at(1, 'PNG\r\n\x1a\n')) return { ext: 'png', type: 'image' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', type: 'image' };
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return { ext: 'gif', type: 'gif' };
  if (at(0, 'RIFF') && at(8, 'WEBP')) return { ext: 'webp', type: 'image' };
  if (at(0, 'RIFF') && at(8, 'WAVE')) return { ext: 'wav', type: 'audio' };
  if (at(4, 'ftyp')) { const brand = b.subarray(8, 12).toString('latin1'); return /^M4[AB]|^F4A/.test(brand) ? { ext: 'm4a', type: 'audio' } : brand.startsWith('qt') ? { ext: 'mov', type: 'video' } : { ext: 'mp4', type: 'video' }; }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { ext: 'webm', type: 'video' };
  if (at(0, 'OggS')) return { ext: 'ogg', type: 'audio' };
  if (at(0, 'fLaC')) return { ext: 'flac', type: 'audio' };
  if (at(0, 'ID3') || (b.length > 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0)) return (b[1] & 0xf6) === 0xf0 ? { ext: 'aac', type: 'audio' } : { ext: 'mp3', type: 'audio' };
  return null;
}

// drop APP1 (EXIF / XMP: camera, GPS...) segments from a JPEG, byte-level
function stripJpegExif(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return b;
  const parts = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xda || marker === 0xd9) break; // start of scan / EOI: the rest is image data
    if (marker >= 0xd0 && marker <= 0xd7 || marker === 0x01) { parts.push(b.subarray(i, i + 2)); i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) break;
    if (marker !== 0xe1) parts.push(b.subarray(i, i + 2 + len)); // keep everything but APP1
    i += 2 + len;
  }
  parts.push(b.subarray(i));
  return Buffer.concat(parts);
}

function dimensions(b, ext) {
  try {
    if (ext === 'png' && b.length >= 24) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (ext === 'gif' && b.length >= 10) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (ext === 'jpg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        if (m === 0xff || (m >= 0xd0 && m <= 0xd8) || m === 0x01) { i += m === 0xff ? 1 : 2; continue; }
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
    if (ext === 'webp' && b.length >= 30) {
      const kind = b.toString('latin1', 12, 16);
      if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
      if (kind === 'VP8X') return { width: (b.readUIntLE(24, 3)) + 1, height: (b.readUIntLE(27, 3)) + 1 };
    }
  } catch { /* unknown size */ }
  return {};
}

function animatedImage(b, ext) {
  if (ext === 'gif') { let n = 0, i = -1; while ((i = b.indexOf(Buffer.from([0x00, 0x21, 0xf9, 0x04]), i + 1)) >= 0) n++; return n > 1; }
  if (ext === 'webp') return b.includes('ANIM');
  if (ext === 'png') return b.includes('acTL');
  return false;
}

function safeExt(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : 'bin';
}
const cleanName = n => clean(String(n || 'file').replace(/[/\\]/g, '_'), 120) || 'file';

function writeStored(rel, buf) {
  const abs = path.join(root(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
}
function removeFiles(rels) {
  for (const rel of rels || []) { try { if (rel && !rel.includes('..')) fs.unlinkSync(path.join(root(), rel)); } catch { /* gone */ } }
}

// a user upload (message attachment). -> the §11 response. expiresAt: when the sweeper deletes it (null = kept)
function storeUpload(buf, originalName, userId, { expiresAt = null } = {}) {
  const sn = sniff(buf);
  const media = !!sn;
  let ext = sn ? sn.ext : safeExt(originalName);
  if (!media && MEDIA_EXT.has(ext)) ext = 'bin'; // claims to be media but isn't
  if (!media && /^(html?|xhtml|svg|js|mjs|xml|php)$/.test(ext)) ext = 'bin';
  if (ext === 'jpg') buf = stripJpegExif(buf);
  const type = sn ? sn.type : 'file';
  const d = new Date();
  const rel = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${randHex(12)}.${ext}`;
  writeStored(rel, buf);
  const hash = sha256(buf);
  const dim = media ? dimensions(buf, ext) : {};
  const name = cleanName(originalName);
  const mime = MIME[ext] || 'application/octet-stream';
  db.run('INSERT INTO uploads (path, sha256, name, size, mime, type, width, height, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', rel, hash, name, buf.length, mime, type, dim.width || null, dim.height || null, userId ?? null, now(), expiresAt);
  return { url: `${normalizeOrigin(config.publicUrl())}/uploads/${rel}`, name, size: buf.length, mime, type, sha256: hash, ...(dim.width ? { width: dim.width, height: dim.height } : {}), ...(expiresAt ? { expires_at: expiresAt } : {}) };
}

// ---------- Server settings > Uploads ----------
// the kind of file, for "Allowed file types": images | videos | audio | pdf | text | archives | other
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'ts', 'py', 'java', 'c', 'h', 'cpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'lua', 'sql', 'srt', 'vtt']);
function kindOf(b, name) {
  const sn = sniff(b);
  if (sn) return sn.type === 'gif' ? 'images' : sn.type === 'image' ? 'images' : sn.type === 'video' ? 'videos' : 'audio';
  const at = (o, sig) => b.length >= o + sig.length && b.subarray(o, o + sig.length).equals(Buffer.from(sig, 'latin1'));
  if (at(0, '%PDF-')) return 'pdf';
  if (at(0, 'PK\x03\x04') || at(0, 'PK\x05\x06') || at(0, 'Rar!') || at(0, '7z\xbc\xaf\x27\x1c') || at(0, '\x1f\x8b') || at(0, 'BZh') || at(0, '\xfd7zXZ\x00') || at(0, '\x28\xb5\x2f\xfd') || at(257, 'ustar')) return 'archives';
  if (TEXT_EXT.has(safeExt(name)) && !b.subarray(0, 8192).includes(0)) return 'text';
  return 'other';
}
const S = () => require('./settings');
const MB = 1024 * 1024;
const recent = new Map(); // user id -> upload times in the last minute
const storageUsed = () => db.get('SELECT COALESCE(SUM(size), 0) AS n FROM uploads').n;
const keptBy = userId => db.get('SELECT COUNT(*) AS n FROM uploads WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)', userId, now()).n;
// before the file is read: uploads per minute, files each member can keep, total storage. -> the uploads settings
function beforeUpload(c, snap, me) {
  const s = S().get(c).uploads;
  const managed = require('./managed');
  if (!snap.isOwner(me.id)) {
    const t = now(), key = `${c.sid}:${me.id}`, list = (recent.get(key) || []).filter(x => t - x < 60000);
    if (recent.size > 5000) for (const [k, v] of recent) if (!v.length || t - v[v.length - 1] > 60000) recent.delete(k);
    if (list.length >= s.per_minute) { recent.set(key, list); throw err('upload_rate_limited', 429, { per_minute: s.per_minute }); }
    list.push(t); recent.set(key, list);
    if (s.files_per_member != null) {
      const used = keptBy(me.id);
      if (used >= s.files_per_member) throw managed.limit('files_per_member') === s.files_per_member ? managed.planLimit('files_per_member', s.files_per_member, used) : err('upload_quota', 403, { limit: s.files_per_member, used });
    }
  }
  if (s.storage_mb != null && storageUsed() >= s.storage_mb * MB) throw managed.limit('storage_mb') === s.storage_mb ? managed.planLimit('storage_mb', s.storage_mb, Math.ceil(storageUsed() / MB)) : err('storage_full', 403, { limit_mb: s.storage_mb });
  return s;
}
// after: the file's type, the storage it would take, image compression, when it expires -> the §11 response
async function acceptUpload(c, me, buf, name, s, { expiresInDays } = {}) {
  const kind = kindOf(buf, name);
  if (!s.types.includes('any') && !s.types.includes(kind)) throw err('file_type_not_allowed', 415, { allowed: s.types });
  const sn = sniff(buf);
  if (s.compress && sn && sn.type === 'image' && !animatedImage(buf, sn.ext)) {
    const out = await require('./images').compress(buf, sn.ext, s, dimensions(buf, sn.ext));
    buf = out.buffer;
  }
  if (s.storage_mb != null && storageUsed() + buf.length > s.storage_mb * MB) throw err('storage_full', 403, { limit_mb: s.storage_mb });
  // the longest a file is kept; members can pick a shorter time. Members on a listed Velora plan or with a listed role keep theirs.
  let days = s.expire_days;
  if (days != null && me.tier && s.never_expire_plans.includes(String(me.tier).toLowerCase())) days = null;
  if (days != null && s.never_expire_roles.length) { // ... and so do members with a listed role
    const snap = require('./communities').snapOf(c), mine = snap.roleIds(me.id);
    if (snap.roles.some(r => s.never_expire_roles.includes(r.rid) && mine.has(r.id))) days = null;
  }
  const pick = Number(expiresInDays);
  if (Number.isInteger(pick) && pick >= 1 && pick <= 3650 && (days == null || pick < days)) days = pick;
  return storeUpload(buf, name, me.id, { expiresAt: days == null ? null : now() + days * 86400000 });
}

// expired uploads: the file and its row go; messages that sent it keep a note that it expired
function sweepExpired() {
  try {
    const origin = normalizeOrigin(config.publicUrl());
    for (const up of db.all('SELECT path FROM uploads WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT 500', now())) {
      removeFiles([up.path]);
      db.run('DELETE FROM uploads WHERE path = ?', up.path);
      const url = `${origin}/uploads/${up.path}`;
      for (const m of db.all('SELECT id, channel_id, attachments FROM messages WHERE attachments LIKE ?', `%/uploads/${up.path}"%`)) {
        let list; try { list = JSON.parse(m.attachments) || []; } catch { continue; }
        const next = list.map(a => (String(a?.url || '').endsWith(`/uploads/${up.path}`) ? { ...a, url, expired: true } : a));
        db.run('UPDATE messages SET attachments = ? WHERE id = ?', JSON.stringify(next), m.id);
        try {
          const ctx = require('./messages').ctxOf(db.get('SELECT * FROM channels WHERE id = ?', m.channel_id));
          require('./gateway').emit(ctx.c.id, { type: 'chat_message_update', message: require('./messages').viewById(m.id, ctx.snap) });
        } catch { /* channel gone */ }
      }
    }
  } catch (e) { console.error('[uploads] expiry sweep', e.message); }
}
let sweeper = null;
function startExpiry() { sweepExpired(); clearInterval(sweeper); sweeper = setInterval(sweepExpired, 5 * 60 * 1000); sweeper.unref?.(); }
function stopExpiry() { clearInterval(sweeper); sweeper = null; }
// a picture for an icon / banner: kept as-is (no re-encoding), images only
function saveImage(buf, kind) {
  const sn = sniff(buf);
  if (!sn || !['image', 'gif'].includes(sn.type)) throw err('images_only');
  if (buf.length > 4 * 1024 * 1024) throw err('file_too_large', 413);
  const rel = `chat/${kind}_${randHex(8)}.${sn.ext}`;
  writeStored(rel, sn.ext === 'jpg' ? stripJpegExif(buf) : buf);
  return `${normalizeOrigin(config.publicUrl())}/uploads/${rel}`;
}
function saveEmoji(buf, eid) {
  const sn = sniff(buf);
  if (!sn || !['image', 'gif'].includes(sn.type)) throw err('images_only');
  if (buf.length > 2 * 1024 * 1024) throw err('file_too_large', 413);
  const rel = `emojis/${eid}.${sn.ext}`;
  writeStored(rel, sn.ext === 'jpg' ? stripJpegExif(buf) : buf);
  return { file: rel, animated: animatedImage(buf, sn.ext) };
}

// parse one multipart file field into memory. -> { buffer, filename, fields }
function readMultipart(req, { maxBytes, field = 'file' } = {}) {
  return new Promise((resolve, reject) => {
    let bb;
    try { bb = Busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: 1, fields: 20, fieldSize: 8192 } }); } catch { return reject(err('bad_request', 400)); }
    const fields = {}; let file = null, tooBig = false;
    bb.on('field', (k, v) => { fields[k] = v; });
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      if (name !== field) { stream.resume(); return; }
      stream.on('data', d => { if (!tooBig) chunks.push(d); });
      stream.on('limit', () => { tooBig = true; chunks.length = 0; req.unpipe(bb); req.resume(); stream.resume(); reject(err('file_too_large', 413, { max_mb: maxBytes / (1024 * 1024) })); });
      stream.on('end', () => { if (!tooBig) file = { buffer: Buffer.concat(chunks), filename: info.filename }; });
    });
    bb.on('error', () => reject(err('bad_request', 400)));
    bb.on('close', () => (tooBig ? reject(err('file_too_large', 413)) : resolve({ buffer: file?.buffer || null, filename: file?.filename, fields })));
    req.pipe(bb);
  });
}

// multipart with several files (webhook / bot messages): -> { fields, files: [{ buffer, filename, mimetype }] }
function readForm(req, { maxBytes = 8 * 1024 * 1024, maxFiles = 10 } = {}) {
  return new Promise((resolve, reject) => {
    let bb;
    try { bb = Busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: maxFiles, fields: 40, fieldSize: 256 * 1024 } }); } catch { return reject(err('bad_request', 400)); }
    const fields = {}, files = []; let tooBig = false;
    bb.on('field', (k, v) => { fields[k] = v; });
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', d => chunks.push(d));
      stream.on('limit', () => { tooBig = true; });
      stream.on('end', () => { if (info.filename) files.push({ buffer: Buffer.concat(chunks), filename: info.filename, mimetype: info.mimeType }); });
    });
    bb.on('error', () => reject(err('bad_request', 400)));
    bb.on('close', () => (tooBig ? reject(err('file_too_large', 413)) : resolve({ fields, files })));
    req.pipe(bb);
  });
}

// GET /uploads/*  (with Range support so video / audio can seek)
function serve(req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice('/uploads/'.length)); } catch { return false; }
  const abs = path.resolve(root(), rel);
  if (!abs.startsWith(path.resolve(root()) + path.sep) || rel.includes('\0')) return false;
  let st; try { st = fs.statSync(abs); } catch { return false; }
  if (!st.isFile()) return false;
  const ext = path.extname(abs).slice(1).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const headers = { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', 'Cross-Origin-Resource-Policy': 'cross-origin' };
  if (!MEDIA_EXT.has(ext)) headers['Content-Disposition'] = 'attachment';
  let start = 0, end = st.size - 1, status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), end); } else { start = Math.max(0, st.size - Number(m[2])); }
    if (start > end || start >= st.size) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${st.size}` }); res.end(); return true; }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(abs, { start, end }).on('error', () => res.destroy()).pipe(res);
  return true;
}

module.exports = { kindOf, beforeUpload, acceptUpload, sweepExpired, startExpiry, stopExpiry, storageUsed, sniff, stripJpegExif, dimensions, storeUpload, saveImage, saveEmoji, removeFiles, readMultipart, readForm, serve, writeStored, root, safeExt };
