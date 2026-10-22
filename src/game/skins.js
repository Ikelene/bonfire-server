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

// No skin from the game (an older mod): ask Mojang's session server for the player's skin by UUID. Real Mojang accounts have v4
// UUIDs; offline-mode (v3) and Floodgate UUIDs have no profile there. One lookup per UUID per 10 minutes, at most one in flight.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let lookup = uuid => fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid.replace(/-/g, '')}`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
const looked = new Map(); // uuid -> { at, skin }
async function skinOfUuid(uuid) {
  uuid = String(uuid || '').toLowerCase();
  if (!UUID_V4.test(uuid)) return null;
  const hit = looked.get(uuid);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.skin;
  let skin = null;
  try {
    const res = await lookup(uuid);
    if (res.ok) {
      const prop = ((await res.json()).properties || []).find(x => x && x.name === 'textures');
      const url = JSON.parse(Buffer.from(String(prop?.value || ''), 'base64').toString('utf8'))?.textures?.SKIN?.url;
      const clean = typeof url === 'string' ? url.replace(/^http:\/\/textures\.minecraft\.net\//, 'https://textures.minecraft.net/') : '';
      skin = TEXTURE_RE.test(clean) ? clean : null;
    }
  } catch { /* offline, rate limited (429) ...: mc-heads.net it is */ }
  if (looked.size > 2000) looked.clear();
  looked.set(uuid, { at: Date.now(), skin });
  return skin;
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

module.exports = { headFor, skinOfUuid, hashOf, purge, TEXTURE_RE, _test: { render, failed, setDownload: fn => { download = fn; }, setLookup: fn => { lookup = fn; looked.clear(); } } };
