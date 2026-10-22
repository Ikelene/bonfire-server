'use strict';
// Minecraft heads for relayed chat. The game sends the player's skin texture URL (from the profile the server already has, so
// it also works for offline-mode servers with a skin plugin, where mc-heads.net can't find the skin by UUID or name). The
// instance fetches that one texture from textures.minecraft.net, cuts out the face + hat layer, enlarges it 8x and serves it
// itself (uploads/game-heads/<hash>.png). Without sharp, or when anything fails, game.js falls back to mc-heads.net.
const fs = require('fs');
const path = require('path');
const uploads = require('../uploads');
const config = require('../config');
const { normalizeOrigin } = require('../util');

const TEXTURE_RE = /^https:\/\/textures\.minecraft\.net\/texture\/([0-9a-f]{16,80})$/;
const MAX_BYTES = 256 * 1024;
const FAIL_TTL = 5 * 60e3;
const failed = new Map();   // hash -> retry-after
const pending = new Map();  // hash -> Promise<url | null>
let sharp; // undefined = not looked for, null = not installed
const lib = () => { if (sharp === undefined) { try { sharp = require('sharp'); } catch { sharp = null; } } return sharp; };

const dir = () => path.join(uploads.root(), 'game-heads');
const urlOf = hash => `${normalizeOrigin(config.publicUrl())}/uploads/game-heads/${hash}.png`;
const hashOf = skin => { const m = TEXTURE_RE.exec(String(skin || '')); return m ? m[1] : null; };

// a skin PNG -> the 64x64 head: face (8,8) with the hat layer (40,8) over it
async function render(buf) {
  const s = lib();
  const meta = await s(buf, { limitInputPixels: 4096 * 4096 }).metadata();
  if (meta.format !== 'png' || meta.width < 64 || meta.height < 32 || meta.width > 1024 || meta.height > 1024) throw new Error('not a skin');
  const k = meta.width / 64; // HD skins are 128x128 ...
  const crop = (x, y) => ({ left: Math.round(x * k), top: Math.round(y * k), width: Math.round(8 * k), height: Math.round(8 * k) });
  const face = await s(buf).extract(crop(8, 8)).removeAlpha().resize(64, 64, { kernel: 'nearest' }).png().toBuffer();
  const hat = await s(buf).ensureAlpha().extract(crop(40, 8)).resize(64, 64, { kernel: 'nearest' }).png().toBuffer();
  return s(face).composite([{ input: hat }]).png({ compressionLevel: 9 }).toBuffer();
}

let download = hash => fetch(`https://textures.minecraft.net/texture/${hash}`, { signal: AbortSignal.timeout(4000), redirect: 'error' });
async function fetchHead(hash) {
  const res = await download(hash);
  if (!res.ok) throw new Error(`textures ${res.status}`);
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('too big');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('too big');
  const png = await render(buf);
  uploads.writeStored(`game-heads/${hash}.png`, png);
  return urlOf(hash);
}

// skin URL from the game -> this instance's head URL, or null (then the caller uses mc-heads.net)
async function headFor(skin) {
  const hash = hashOf(skin);
  if (!hash || !lib()) return null;
  if (fs.existsSync(path.join(dir(), `${hash}.png`))) return urlOf(hash);
  if ((failed.get(hash) || 0) > Date.now()) return null;
  if (!pending.has(hash)) {
    pending.set(hash, fetchHead(hash).catch(e => { failed.set(hash, Date.now() + FAIL_TTL); console.error('[game] skin', hash.slice(0, 8), e.message); return null; })
      .finally(() => pending.delete(hash)));
  }
  return pending.get(hash);
}

// hourly (game.purge): heads nobody asked for in 30 days
function purge() {
  try {
    const old = Date.now() - 30 * 24 * 3600e3;
    for (const f of fs.existsSync(dir()) ? fs.readdirSync(dir()) : []) {
      const p = path.join(dir(), f);
      if (f.endsWith('.png') && fs.statSync(p).mtimeMs < old) fs.unlinkSync(p);
    }
    for (const [h, t] of failed) if (t < Date.now()) failed.delete(h);
  } catch { /* nothing to clean */ }
}

module.exports = { headFor, hashOf, purge, TEXTURE_RE, _test: { render, failed, setDownload: fn => { download = fn; } } };
