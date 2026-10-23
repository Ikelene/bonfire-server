'use strict';
// Soundboard: a community keeps short sounds (Manage server uploads them); anyone in one of its voice channels can play one and
// everyone in that voice room hears it (gateway frame `voice_sound`, see gateway.js). Files live in DATA_DIR/uploads/sounds/<id>.<ext>.
// Velora transcodes with ffmpeg; the instance has no native tools, so it stores the file as uploaded (mp3, wav, ogg, flac, m4a - the
// type is checked by magic bytes) and reads the duration from the headers; clips must be at most 5.2 s.
const config = require('./config');
const managed = require('./managed');
const db = require('./db');
const C = require('./communities');
const uploads = require('./uploads');
const { P } = require('./perms');
const { err, clean, randHex, now, normalizeOrigin } = require('./util');

const MAX_PER_COMMUNITY = 30, MAX_BYTES = 8 * 1024 * 1024, MAX_MS = 5300, COOLDOWN = 1200;
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a']);

// ---- duration from headers (ms; 0 = unknown / unsupported) ----
const MP3_BR = { 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
const MP3_SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
function mp3(b) {
  let i = 0;
  if (b.toString('latin1', 0, 3) === 'ID3' && b.length > 10) i = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f));
  for (; i + 4 < b.length; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3, bi = b[i + 2] >> 4, si = (b[i + 2] >> 2) & 3;
    if (ver === 1 || layer !== 1 || bi === 0 || bi === 15 || si === 3) continue; // Layer III only
    const kbps = MP3_BR[ver === 3 ? 1 : 2][bi], rate = MP3_SR[ver][si], spf = ver === 3 ? 1152 : 576, mono = (b[i + 3] >> 6) === 3;
    const side = ver === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17), x = i + 4 + side;
    const tag = b.toString('latin1', x, x + 4);
    if ((tag === 'Xing' || tag === 'Info') && b.readUInt32BE(x + 4) & 1) return Math.round(b.readUInt32BE(x + 8) * spf / rate * 1000);
    return Math.round((b.length - i) * 8 / (kbps * 1000) * 1000);
  }
  return 0;
}
function wav(b) {
  let byteRate = 0;
  for (let i = 12; i + 8 <= b.length;) {
    const id = b.toString('latin1', i, i + 4), n = b.readUInt32LE(i + 4);
    if (id === 'fmt ' && i + 20 <= b.length) byteRate = b.readUInt32LE(i + 16);
    if (id === 'data') return byteRate ? Math.round(Math.min(n, b.length - i - 8) / byteRate * 1000) : 0;
    i += 8 + n + (n & 1);
  }
  return 0;
}
function ogg(b) {
  const opus = b.indexOf('OpusHead'), vorbis = b.indexOf('\x01vorbis');
  const rate = opus >= 0 ? 48000 : vorbis >= 0 ? b.readUInt32LE(vorbis + 12) : 0;
  const last = b.lastIndexOf('OggS');
  if (!rate || last < 0 || last + 14 > b.length) return 0;
  const g = Number(b.readBigUInt64LE(last + 6));
  return g > 0 ? Math.round((g - (opus >= 0 ? b.readUInt16LE(opus + 10) : 0)) / rate * 1000) : 0;
}
function flac(b) {
  if (b.length < 26 || b.toString('latin1', 0, 4) !== 'fLaC') return 0;
  const s = b.subarray(18, 26), rate = (s[0] << 12) | (s[1] << 4) | (s[2] >> 4), total = (s[3] & 0x0f) * 2 ** 32 + s.readUInt32BE(4);
  return rate && total ? Math.round(total / rate * 1000) : 0;
}
function m4a(b) {
  const i = b.indexOf('mvhd');
  if (i < 0 || i + 24 > b.length) return 0;
  const v = b[i + 4];
  const scale = b.readUInt32BE(i + (v === 1 ? 20 : 12)), dur = v === 1 ? Number(b.readBigUInt64BE(i + 24)) : b.readUInt32BE(i + 16);
  return scale ? Math.round(dur / scale * 1000) : 0;
}
const duration = (b, ext) => { try { return { mp3, wav, ogg, flac, m4a }[ext]?.(b) || 0; } catch { return 0; } };

// ---- views + access ----
const url = r => `${normalizeOrigin(config.publicUrl())}/uploads/${r.file}`;
const view = r => ({ id: r.sid, name: r.name, emoji: r.emoji || null, volume: r.volume, duration: r.duration_ms, url: url(r) });
function manager(sid, me) {
  const r = C.memberCommunity(sid, me);
  if (!r.snap.can(me.id, P.MANAGE_SERVER)) throw err('not_allowed', 403);
  return r.c;
}
const cleanName = n => String(n || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 32);
const cleanEmoji = e => { e = String(e || '').trim(); return /^(\p{Extended_Pictographic}|\p{Regional_Indicator})/u.test(e) && e.length <= 16 ? e : /^<a?:\w{1,32}:e[0-9a-f]{10}>$/.test(e) ? e : null; };
const own = (c, id) => { const r = db.get('SELECT * FROM sounds WHERE sid = ? AND community_id = ?', String(id), c.id); if (!r) throw err('not_found', 404); return r; };

// every sound from the communities you're in
function mine(me) {
  return { servers: db.all('SELECT c.* FROM communities c JOIN members m ON m.community_id = c.id WHERE m.user_id = ? ORDER BY c.id', me.id)
    .map(c => ({ sid: c.sid, name: c.name, icon: c.icon_url || null, sounds: db.all('SELECT * FROM sounds WHERE community_id = ? ORDER BY id', c.id).map(view) })).filter(x => x.sounds.length) };
}
function list(sid, me) {
  const { c } = C.memberCommunity(sid, me);
  return { sounds: db.all('SELECT * FROM sounds WHERE community_id = ? ORDER BY id', c.id).map(view), max: Math.min(MAX_PER_COMMUNITY, managed.limit('sounds') ?? MAX_PER_COMMUNITY) };
}
function add(sid, me, file, body = {}) {
  const c = manager(sid, me);
  if (!file?.buffer?.length) throw err('no_file');
  if (file.buffer.length > MAX_BYTES) throw err('file_too_large', 413);
  const have = db.get('SELECT COUNT(*) AS n FROM sounds WHERE community_id = ?', c.id).n;
  managed.assertRoom('sounds', have);
  if (have >= MAX_PER_COMMUNITY) throw err('too_many_sounds');
  const sn = uploads.sniff(file.buffer);
  if (!sn || sn.type !== 'audio' || !AUDIO_EXT.has(sn.ext)) throw err('not_audio');
  const ms = duration(file.buffer, sn.ext);
  if (!ms) throw err('not_audio');
  if (ms > MAX_MS) throw err('sound_too_long');
  const id = 'snd' + randHex(5), rel = `sounds/${id}.${sn.ext}`;
  uploads.writeStored(rel, file.buffer);
  const name = cleanName(body.name) || cleanName(String(file.filename || '').replace(/\.[^.]+$/, '')) || 'sound';
  db.run('INSERT INTO sounds (sid, community_id, name, emoji, volume, duration_ms, file, created_by, created_at) VALUES (?, ?, ?, ?, 100, ?, ?, ?, ?)', id, c.id, name, cleanEmoji(body.emoji), ms, rel, me.id, now());
  return { sound: view(db.get('SELECT * FROM sounds WHERE sid = ?', id)) };
}
function update(sid, me, id, body = {}) {
  const r = own(manager(sid, me), id), set = {};
  if (body.name !== undefined) { set.name = cleanName(body.name); if (!set.name) throw err('name_required'); }
  if (body.emoji !== undefined) set.emoji = cleanEmoji(body.emoji);
  if (body.volume !== undefined) set.volume = Math.max(5, Math.min(100, Math.round(Number(body.volume) || 100)));
  if (Object.keys(set).length) db.run(`UPDATE sounds SET ${Object.keys(set).map(k => k + ' = ?').join(', ')} WHERE id = ?`, ...Object.values(set), r.id);
  return { sound: view({ ...r, ...set }) };
}
function remove(sid, me, id) {
  const r = own(manager(sid, me), id);
  db.run('DELETE FROM sounds WHERE id = ?', r.id);
  uploads.removeFiles([r.file]);
}

// playing: the sound must belong to the community of the voice room (the gateway checks the player is in that room)
const last = new Map(); // userId -> ms
function gate(user, communityId) {
  if (!db.get('SELECT 1 FROM members WHERE community_id = ? AND user_id = ?', communityId, user.id)) return 'not_allowed';
  if (require('./moderation').timeoutUntil({ id: communityId }, user.id)) return 'timed_out';
  const t = now();
  if (t - (last.get(user.id) || 0) < COOLDOWN) return 'too_fast';
  last.set(user.id, t);
  return null;
}
function playable(user, soundId, communityId) {
  const r = db.get('SELECT * FROM sounds WHERE sid = ?', String(soundId || ''));
  if (!r || (communityId != null && r.community_id !== communityId)) return { error: 'not_found' };
  const error = gate(user, r.community_id);
  return error ? { error } : { sound: view(r) };
}
// A sound from another server (another instance, or Velora) that the player picked in their own soundboard: the client sends its
// public view and the room is told to play that URL. Only the shape is checked here (an audio file under /uploads/sounds/ on an
// http(s) origin, sane name / volume / length): this instance never fetches it, and listeners only play origins they already trust.
const EXTERNAL_PATH = /^\/uploads\/sounds\/[A-Za-z0-9_-]{3,40}\.(mp3|wav|ogg|flac|m4a)$/;
function external(user, communityId, s) {
  let u;
  try { u = new URL(String(s?.url || '')); } catch { return { error: 'not_found' }; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash || !EXTERNAL_PATH.test(u.pathname) || u.href.length > 300) return { error: 'not_found' };
  const error = gate(user, communityId);
  if (error) return { error };
  const emoji = cleanEmoji(s.emoji);
  return { sound: { id: null, external: true, name: cleanName(s.name) || 'sound', emoji: emoji && !emoji.startsWith('<') ? emoji : null,
    volume: Math.max(5, Math.min(100, Math.round(Number(s.volume) || 100))), duration: Math.max(0, Math.min(MAX_MS, Math.round(Number(s.duration) || 0))), url: u.href } };
}

module.exports = { mine, list, add, update, remove, playable, external, duration, view, MAX_PER_COMMUNITY };
