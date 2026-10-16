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

// a user upload (message attachment). -> the §11 response
function storeUpload(buf, originalName, userId) {
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
  db.run('INSERT INTO uploads (path, sha256, name, size, mime, type, width, height, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', rel, hash, name, buf.length, mime, type, dim.width || null, dim.height || null, userId ?? null, now());
  return { url: `${normalizeOrigin(config.publicUrl())}/uploads/${rel}`, name, size: buf.length, mime, type, sha256: hash, ...(dim.width ? { width: dim.width, height: dim.height } : {}) };
}
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
      stream.on('data', d => chunks.push(d));
      stream.on('limit', () => { tooBig = true; });
      stream.on('end', () => { file = { buffer: Buffer.concat(chunks), filename: info.filename }; });
    });
    bb.on('error', () => reject(err('bad_request', 400)));
    bb.on('close', () => (tooBig ? reject(err('file_too_large', 413)) : resolve({ buffer: file?.buffer || null, filename: file?.filename, fields })));
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

module.exports = { sniff, stripJpegExif, dimensions, storeUpload, saveImage, saveEmoji, removeFiles, readMultipart, serve, writeStored, root, safeExt };
