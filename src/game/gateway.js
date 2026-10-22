'use strict';
// Ember Link game gateway: ws(s)://INSTANCE/game-gateway?v=1 (ported from Velora's game-gateway.js; PROTOCOL §18).
// One outbound socket per Minecraft "root" (a Velocity proxy, or a standalone Paper / Fabric server). The plugin is pointed
// at this instance with the console command `bonfire server <url>`.
// Handshake = Ed25519 identity (trust on first use), then status / chat / events / console over JSON frames { op, d, id? }.
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const db = require('../db');
const auth = require('../auth');
const store = require('../bridge/store');
const G = require('./game');
const { now, randHex } = require('../util');

const C = () => require('../communities');
const gateway = () => require('../gateway');

const PROTOCOL = 1;
const HEARTBEAT_MS = 30000;
const MAX_FRAME = 64 * 1024;
const IDENTIFY_TIMEOUT = 15000;
const OFFLINE_GRACE = 60000;
const LIST_FRESH = 3 * 60 * 1000;  // listed only if a heartbeat / status came in the last 3 minutes
const PAGE = 20;
const RING = 1000;                 // console lines kept per instance
const LIMITS = { frames_per_s: 30, chat_per_10s: 20 };
// tunable for tests only
const T = { listMinAge: 10000, excessMs: 10000, newPerIpDay: 5, newPerHour: 200, socketsPerIp: 10 };

const sessions = new Map(); // iid -> session (identified sockets only)
const sockets = new Set();
const live = new Map();     // iid -> { online, last_seen, status, offlineTimer, statusTimer, persistTimer, stopped }
const consoles = new Map(); // iid -> ring
const claims = new Map();   // normalised code -> claim
const pending = new Map();  // console.exec req -> { resolve, timer, iid }
const perIp = new Map();    // ip hash -> open sockets
const rate = new Map();     // key -> [times]
let wss = null, sweeper = null;

function hit(key, max, windowMs) {
  const t = now();
  const list = (rate.get(key) || []).filter(x => t - x < windowMs);
  if (list.length >= max) { rate.set(key, list); return false; }
  list.push(t); rate.set(key, list);
  return true;
}
function ipSalt() {
  let s = store.setting('game.ip_salt');
  if (!s) { s = randHex(16); store.setSetting('game.ip_salt', s); }
  return s;
}
const hashIp = ip => crypto.createHash('sha256').update(`${ipSalt()}|${ip}`).digest('hex');
function realIp(req) {
  if (process.env.BONFIRE_TRUST_PROXY === '1') { const x = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); if (x) return x; }
  return String(req.socket?.remoteAddress || '');
}
function frame(sock, op, d, id) {
  if (!sock || sock.readyState !== 1) return false;
  const o = { op, d: d || {} };
  if (id !== undefined) o.id = id;
  try { sock.send(JSON.stringify(o)); return true; } catch { return false; }
}
function close(sock, code, reason = '') { try { sock.close(code, String(reason).slice(0, 120)); } catch { /* gone */ } }
const liveOf = iid => { if (!live.has(iid)) live.set(iid, { online: false, last_seen: 0, status: undefined }); return live.get(iid); };
const isConnected = iid => !!sessions.get(iid)?.ready;
function send(iid, op, d) { const s = sessions.get(iid); return s?.ready ? frame(s.sock, op, d) : false; }
const clampStr = (v, n) => G.plainText(v, n);
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : undefined; };

// ---------------------------------------------------------------- status (in memory; last_status persisted every <= 10 s)
function statusOf(iid) {
  const l = liveOf(iid);
  if (l.status === undefined) {
    const r = G.instanceRow(iid);
    try { l.status = r?.last_status ? JSON.parse(r.last_status) : null; } catch { l.status = null; }
    if (!l.last_seen && r) l.last_seen = r.last_seen;
  }
  return l.status;
}
function cleanStatus(d) {
  const players = d.players && typeof d.players === 'object' ? d.players : {};
  const list = (Array.isArray(players.list) ? players.list : []).slice(0, 100).map(p => ({
    uuid: /^[0-9a-f-]{32,36}$/i.test(String(p?.uuid || '')) ? String(p.uuid).toLowerCase() : undefined,
    name: clampStr(p?.name, 32), display: clampStr(p?.display, 80) || undefined, server: clampStr(p?.server, 40) || undefined,
  })).filter(p => p.name);
  const out = {
    online: d.online !== false, version: clampStr(d.version, 80), motd: G.cleanSegments(d.motd),
    players: { online: num(players.online, 0, 1e6) ?? list.length, max: num(players.max, 0, 1e6) ?? 0, list },
    tps: num(d.tps, 0, 100), uptime_s: num(d.uptime_s, 0, 1e9),
  };
  if (Array.isArray(d.backends)) {
    out.backends = d.backends.slice(0, 50).map(b => ({
      name: clampStr(b?.name, 40), online: b?.online === true, version: clampStr(b?.version, 40) || undefined,
      motd: G.cleanSegments(b?.motd), players: b?.players ? { online: num(b.players.online, 0, 1e6) ?? 0, max: num(b.players.max, 0, 1e6) ?? 0 } : undefined,
    })).filter(b => b.name);
  }
  return out;
}
function persist(iid) {
  const l = liveOf(iid);
  const st = l.status;
  try { db.run('UPDATE game_instances SET last_status = ?, last_seen = ?, motd = COALESCE(?, motd) WHERE iid = ?', st ? JSON.stringify(st) : null, now(), st?.motd?.length ? JSON.stringify(st.motd) : null, iid); } catch { /* closed */ }
}
function persistSoon(iid) {
  const l = liveOf(iid);
  if (l.persistTimer) return;
  l.persistTimer = setTimeout(() => { l.persistTimer = null; persist(iid); }, 10000);
  l.persistTimer.unref?.();
}
function statusChanged(iid) {
  const l = liveOf(iid);
  if (l.statusTimer) return;
  l.statusTimer = setTimeout(() => { l.statusTimer = null; try { G.broadcastStatus(iid); } catch { /* closed */ } }, 2000); // debounced
  l.statusTimer.unref?.();
}
function setOnline(iid, on) {
  const l = liveOf(iid);
  clearTimeout(l.offlineTimer); l.offlineTimer = null;
  if (l.online === on) return;
  l.online = on;
  l.last_seen = now();
  if (!on && l.status) l.status = { ...l.status, online: false };
  persistSoon(iid);
  G.broadcastStatus(iid);
}

// ---------------------------------------------------------------- console ring buffer
function ringOf(iid) {
  if (!consoles.has(iid)) consoles.set(iid, { seq: 0, lines: [], sec: 0, inSec: 0, skipped: 0, frameSec: 0, frames: 0, cmdTimes: [], cmdSkipped: 0 });
  return consoles.get(iid);
}
function addLine(iid, line) {
  const r = ringOf(iid);
  const l = { seq: ++r.seq, t: now(), ...line };
  r.lines.push(l);
  if (r.lines.length > RING) r.lines.splice(0, r.lines.length - RING);
  return l;
}
function updateLine(iid, seq, patch) { const l = ringOf(iid).lines.find(x => x.seq === seq); if (l) Object.assign(l, patch); return l || null; }
function consoleLines(iid, { before } = {}) {
  const b = Number(before) || Infinity;
  const older = ringOf(iid).lines.filter(l => l.seq < b);
  return { lines: older.slice(-200), has_more: older.length > 200 };
}

// ---------------------------------------------------------------- claim codes (the alternative to picking from the list)
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const normCode = v => String(v || '').toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
const showCode = c => `${c.slice(0, 4)}-${c.slice(4)}`;
function createClaim({ c, user, cid, hint }) {
  if (!hit(`claim:${user.id}`, 10, 3600000)) throw Object.assign(new Error('rate_limited'), { code: 'rate_limited', status: 429 });
  let code;
  do {
    let n = BigInt('0x' + crypto.randomBytes(5).toString('hex'));
    code = '';
    for (let i = 0; i < 8; i++) { code = CROCK[Number(n & 31n)] + code; n >>= 5n; }
  } while (claims.has(code));
  claims.set(code, { code, communityId: c.id, sid: c.sid, userId: Number(user.id), username: user.username, cid: cid || null, hintIid: hint || null, exp: now() + 10 * 60 * 1000, state: 'pending', iid: null });
  return { code: showCode(code), command: `bonfire link ${showCode(code)}`, expires_at: claims.get(code).exp };
}
function claimState(code, user) {
  const c = claims.get(normCode(code));
  if (!c || c.userId !== Number(user.id)) throw Object.assign(new Error('claim_not_found'), { code: 'claim_not_found', status: 404 });
  if (c.state === 'linked') return { state: 'linked', instance: G.instanceView(G.instanceRow(c.iid)), hint: c.hintIid };
  if (now() > c.exp) return { state: 'expired' };
  return { state: 'pending', expires_at: c.exp };
}

// ---------------------------------------------------------------- "Connected game servers": unclaimed sessions on this instance
function listable(s, t = now()) {
  return s.ready && s.inst && !s.inst.banned && !G.linkOfIid(s.iid) && t - s.lastBeat <= LIST_FRESH && t - s.startedAt >= T.listMinAge;
}
function unclaimed({ tag, q, page } = {}) {
  const t = now();
  const wantTag = G.normTag(tag);
  const query = String(q || '').trim().toLowerCase().slice(0, 60);
  let list = [...sessions.values()].filter(s => listable(s, t));
  if (wantTag) list = list.filter(s => s.tagRaw === wantTag);
  else list = list.filter(s => s.inst.listing !== 'private'); // a "private" server only shows up for its pairing tag
  if (query) list = list.filter(s => `${G.segmentsPlain(G.motdOf(s.inst))} ${s.inst.platform} ${s.inst.mc_version} ${s.inst.software}`.toLowerCase().includes(query));
  list.sort((a, b) => b.startedAt - a.startedAt || (a.iid < b.iid ? -1 : 1));
  if (!wantTag) { // many servers behind one address (hosting providers): the unfiltered list shows the 20 newest per address
    const seen = new Map();
    list = list.filter(s => { const n = (seen.get(s.ipHash) || 0) + 1; seen.set(s.ipHash, n); return n <= 20; });
  }
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const p = Math.min(Math.max(1, Math.trunc(Number(page) || 1)), pages);
  return {
    instances: list.slice((p - 1) * PAGE, p * PAGE).map(s => ({
      iid: s.iid, platform: s.inst.platform, mc_version: s.inst.mc_version, motd: G.motdOf(s.inst), icon: s.inst.icon_url || null,
      players: { online: statusOf(s.iid)?.players?.online ?? 0, max: statusOf(s.iid)?.players?.max ?? s.maxPlayers ?? 0 }, pairing_tag: s.tag, connected_at: s.startedAt,
    })),
    total, page: p, pages, tag_match: !!wantTag && total > 0,
  };
}

// ---------------------------------------------------------------- relay flags -> the game side
function pushConfig(iid) {
  const s = sessions.get(iid);
  if (!s?.ready) return;
  const f = G.flagsOf(iid);
  const key = JSON.stringify(f);
  if (key === s.flags) return;
  s.flags = key;
  frame(s.sock, 'config', f);
}

// ---------------------------------------------------------------- linking (claim code from the console, or an admin's pick)
function afterLink(s, res, who, claimCode) {
  frame(s.sock, 'linked', { server_name: res.c.name, sid: res.c.sid, linked_by: who.username });
  gateway().emit(res.c.id, { type: 'game_linked', server: res.c.sid, instance: res.view, claim: claimCode || undefined, hint: who.hintIid || undefined });
  s.flags = null;
  pushConfig(s.iid);
  G.broadcastStatus(s.iid);
}
// the new flow: `bonfire server <url>` connects the plugin here, it shows up as connected + unclaimed, an admin picks it
function linkConnected(c, user, iid, cid) {
  const s = sessions.get(String(iid || ''));
  if (!s || !s.ready || !s.inst) throw Object.assign(new Error('not_connected'), { code: 'not_connected', status: 404 });
  if (s.inst.banned) throw Object.assign(new Error('not_allowed'), { code: 'not_allowed', status: 403 });
  if (G.linkOfIid(s.iid)) throw Object.assign(new Error('already_linked'), { code: 'already_linked', status: 409 });
  const who = { communityId: c.id, userId: user.id, username: user.username, cid };
  const res = G.link(G.instanceRow(s.iid), who);
  afterLink(s, res, who, null);
  return { instance: res.view };
}
function linkFrom(s, d, id) {
  const reply = r => frame(s.sock, 'link_result', r, id);
  if (!hit(`link:${s.iid}`, 5, 10 * 60 * 1000)) return reply({ ok: false, error: 'rate_limited' });
  const code = normCode(d.code);
  const claim = claims.get(code);
  if (!claim || claim.state !== 'pending') return reply({ ok: false, error: 'invalid_code' });
  if (now() > claim.exp) return reply({ ok: false, error: 'expired' });
  const c = db.get('SELECT * FROM communities WHERE id = ?', claim.communityId);
  const snap = c && C().snapOf(c);
  if (!snap || !snap.isMember(claim.userId) || !snap.can(claim.userId, require('../perms').P.MANAGE_SERVER)) return reply({ ok: false, error: 'not_allowed' });
  const existing = G.linkOfIid(s.iid);
  if (existing) return reply({ ok: false, error: 'already_linked', server_name: existing.community_id === c.id ? c.name : undefined });
  let res;
  try { res = G.link(s.inst, { communityId: c.id, userId: claim.userId, username: claim.username, cid: claim.cid }); }
  catch (e) { return reply({ ok: false, error: ['already_linked', 'too_many_instances', 'not_allowed'].includes(e.code) ? e.code : 'not_allowed' }); }
  claim.state = 'linked';
  claim.iid = s.iid;
  reply({ ok: true, server_name: c.name });
  afterLink(s, res, { username: claim.username, hintIid: claim.hintIid }, showCode(code));
}

// ---------------------------------------------------------------- console exec (REST -> game)
async function exec(iid, command, user, communityId) {
  const s = sessions.get(iid);
  const auditId = G.audit(communityId, iid, user.id, 'command', command, 'sent', null);
  const line = addLine(iid, { kind: 'command', source: 'bonfire', by: user.username, pfp: user.pfp || undefined, command, status: 'sent' });
  G.broadcastConsole(iid, [line]);
  const finish = (status, output, extra) => {
    const l = updateLine(iid, line.seq, { status });
    if (l) G.broadcastConsole(iid, [l]);
    try { G.auditUpdate(auditId, status, output); } catch { /* closed */ }
    return extra;
  };
  if (!s?.ready) return finish('error', 'offline', { ok: false, error: 'offline' });
  if (s.features && s.features.console_exec === false) return finish('denied', 'console_disabled', { ok: false, error: 'console_disabled' });
  const req = crypto.randomBytes(6).toString('base64url');
  const result = await new Promise(resolve => {
    const timer = setTimeout(() => { pending.delete(req); resolve({ ok: false, error: 'timeout' }); }, 10000);
    timer.unref?.();
    pending.set(req, { resolve, timer, iid });
    frame(s.sock, 'console.exec', { req, command, by: user.username });
  });
  const output = Array.isArray(result.output) ? result.output : [];
  const status = result.ok ? 'ok' : result.error === 'timeout' ? 'timeout' : result.error === 'console_disabled' ? 'denied' : 'error';
  return finish(status, output.join('\n') || result.error || null, result.ok ? { ok: true, output, truncated: !!result.truncated } : { ok: false, error: result.error || 'error', output: output.length ? output : undefined });
}

// ---------------------------------------------------------------- the socket
function connection(sock, req) {
  const url = new URL(String(req.url || '/'), 'http://x');
  const ipHash = hashIp(realIp(req));
  sockets.add(sock);
  const s = { sock, ipHash, iid: null, ready: false, startedAt: now(), lastBeat: now(), tokens: 60, lastFill: now(), excessSince: 0, lastExcess: 0, lastRateErr: 0, flags: null };
  const n = (perIp.get(ipHash) || 0) + 1;
  perIp.set(ipHash, n);
  sock.on('close', () => onClose(s));
  sock.on('error', () => {});
  if (n > T.socketsPerIp) { close(sock, 4008, 'too many connections from this address'); return; }
  const v = url.searchParams.get('v');
  if (v && Number(v) !== PROTOCOL) { close(sock, 4007, 'unsupported protocol version'); return; }
  s.nonce = crypto.randomBytes(32).toString('base64url');
  frame(sock, 'hello', { v: PROTOCOL, nonce: s.nonce, heartbeat_ms: HEARTBEAT_MS });
  s.identifyTimer = setTimeout(() => { if (!s.ready) close(sock, 4002, 'identify timeout'); }, IDENTIFY_TIMEOUT);
  s.identifyTimer.unref?.();
  sock.on('message', (raw, isBinary) => {
    if (isBinary) { close(sock, 4001, 'text frames only'); return; }
    if (raw.length > MAX_FRAME) { close(sock, 1009, 'frame too big'); return; }
    // token bucket: 30 frames / s, burst 60; 10 s of sustained excess closes the socket (4005)
    const t = now();
    s.tokens = Math.min(60, s.tokens + ((t - s.lastFill) / 1000) * LIMITS.frames_per_s);
    s.lastFill = t;
    if (s.tokens < 1) {
      if (!s.excessSince || t - s.lastExcess > 2000) s.excessSince = t;
      s.lastExcess = t;
      if (t - s.excessSince >= T.excessMs) { close(sock, 4005, 'rate limited'); return; }
      if (t - s.lastRateErr > 5000) { s.lastRateErr = t; frame(sock, 'error', { code: 'rate_limited', message: 'Too many frames - some were dropped.', fatal: false }); }
      return;
    }
    s.tokens -= 1;
    let m;
    try { m = JSON.parse(raw.toString('utf8')); } catch { close(sock, 4001, 'malformed frame'); return; }
    if (!m || typeof m !== 'object' || typeof m.op !== 'string') { close(sock, 4001, 'malformed frame'); return; }
    const d = m.d && typeof m.d === 'object' ? m.d : {};
    if (!s.ready) {
      if (m.op !== 'identify' || s.identifying) { close(sock, 4001, 'identify first'); return; }
      s.identifying = true;
      try { identify(s, d); } catch (e) { console.error('[game-gw] identify', e.message); close(sock, 4000, 'server error'); }
      return;
    }
    s.lastBeat = t;
    liveOf(s.iid).last_seen = t;
    Promise.resolve().then(() => handle(s, m.op, d, m.id)).catch(e => console.error('[game-gw]', m.op, e.message));
  });
}

const PLATFORMS = ['paper', 'spigot', 'fabric', 'velocity', 'forge'];
function identify(s, d) {
  G.ensure();
  if (Number(d.v) !== PROTOCOL) { close(s.sock, 4007, 'unsupported protocol version'); return; }
  let der, key;
  try {
    der = Buffer.from(String(d.key || ''), 'base64');
    key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519' || der.length !== 44) throw new Error('not ed25519');
  } catch { close(s.sock, 4003, 'bad key'); return; }
  const id = G.identityOf(der);
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(`bonfire-gw-v1|${s.nonce}|${id.iid}`, 'utf8'), key, Buffer.from(String(d.sig || ''), 'base64')); } catch { ok = false; }
  if (!ok) { close(s.sock, 4003, 'bad signature'); return; }
  const pub = der.toString('base64');
  let inst = G.instanceRow(id.iid);
  if (inst && inst.pubkey !== pub) { close(s.sock, 4003, 'bad key'); return; }
  const fields = {
    platform: PLATFORMS.includes(d.platform) ? d.platform : 'paper', software: clampStr(d.software, 80), mc_version: clampStr(d.mc_version, 40), mod_version: clampStr(d.mod_version, 20),
    listing: d.listing === 'private' ? 'private' : 'public', motd: JSON.stringify(G.cleanSegments(d.motd)), public_address: clampStr(d.public_address, 120),
  };
  if (inst?.banned) { close(s.sock, 4004, 'banned'); return; }
  const t = now();
  if (!inst) {
    // a new identity: 5 per address per day, 200 per hour on the whole instance
    const mine = db.get('SELECT COUNT(*) AS n FROM game_instances WHERE created_ip_hash = ? AND first_seen > ?', s.ipHash, t - 86400e3).n;
    const all = db.get('SELECT COUNT(*) AS n FROM game_instances WHERE first_seen > ?', t - 3600e3).n;
    if (all >= T.newPerHour) console.warn(`[game-gw] WARNING: ${T.newPerHour}+ new Ember Link identities in the last hour - new ones are refused (4008)`);
    if (mine >= T.newPerIpDay || all >= T.newPerHour) { close(s.sock, 4008, 'too many new servers from this address'); return; }
    db.run('INSERT INTO game_instances (iid, pubkey, platform, software, mc_version, mod_version, listing, motd, public_address, first_seen, last_seen, created_ip_hash, last_ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id.iid, pub, fields.platform, fields.software, fields.mc_version, fields.mod_version, fields.listing, fields.motd, fields.public_address, t, t, s.ipHash, s.ipHash);
  } else {
    db.run('UPDATE game_instances SET platform = ?, software = ?, mc_version = ?, mod_version = ?, listing = ?, motd = ?, public_address = ?, last_seen = ?, last_ip_hash = ? WHERE id = ?',
      fields.platform, fields.software, fields.mc_version, fields.mod_version, fields.listing, fields.motd, fields.public_address, t, s.ipHash, inst.id);
  }
  inst = G.instanceRow(id.iid);
  if (s.sock.readyState !== 1) return;
  const old = sessions.get(id.iid); // one session per instance: the newer one wins
  if (old && old !== s) { old.replaced = true; close(old.sock, 4006, 'replaced by a newer session'); }
  clearTimeout(s.identifyTimer);
  Object.assign(s, { iid: id.iid, tag: id.tag, tagRaw: id.tagRaw, inst, ready: true, startedAt: now(), lastBeat: now(), features: d.features && typeof d.features === 'object' ? d.features : {}, maxPlayers: num(d.max_players, 0, 1e6) });
  sessions.set(id.iid, s);
  s.iconSha = /^[0-9a-f]{64}$/i.test(String(d.icon_sha256 || '')) ? String(d.icon_sha256).toLowerCase() : null;
  const link = G.linkOfIid(id.iid);
  let linked = null;
  if (link) {
    const c = db.get('SELECT * FROM communities WHERE id = ?', link.community_id);
    linked = c ? { server_name: c.name, sid: c.sid, linked_by: link.linked_by ? auth.userById(link.linked_by)?.username || null : null, linked_at: link.linked_at } : null;
  }
  const flags = G.flagsOf(id.iid);
  s.flags = JSON.stringify(flags);
  frame(s.sock, 'ready', {
    iid: id.iid, pairing_tag: id.tag, linked, icon_needed: !!s.iconSha && (s.iconSha !== inst.icon_sha256 || !inst.icon_url),
    relay: flags.relay, console_stream: flags.console_stream, limits: LIMITS,
  });
  if (!s.iconSha && inst.icon_url) { db.run('UPDATE game_instances SET icon_url = NULL, icon_sha256 = NULL WHERE id = ?', inst.id); inst.icon_url = null; inst.icon_sha256 = null; }
  liveOf(id.iid).stopped = false;
  setOnline(id.iid, true);
}

function handle(s, op, d, id) {
  const iid = s.iid;
  switch (op) {
    case 'heartbeat': frame(s.sock, 'heartbeat_ack', { seq: Number(d.seq) || 0 }); return;
    case 'status': {
      const st = cleanStatus(d);
      liveOf(iid).status = st;
      if (st.motd.length) s.inst.motd = JSON.stringify(st.motd);
      persistSoon(iid);
      statusChanged(iid);
      return;
    }
    case 'icon': return saveIcon(s, d);
    case 'chat': case 'event': {
      if (!G.linkOfIid(iid)) return;
      if (op === 'event' && d.kind === 'server_stop') liveOf(iid).stopped = true;
      if (!hit(`post:${iid}`, LIMITS.chat_per_10s, 10000)) { G.noteSkipped(iid); return; }
      // the skin the game sent becomes this instance's own head image (a few seconds the first time, then cached); frames
      // are posted in order, so a slow download holds the ones behind it instead of letting them overtake it
      delete d._head;
      const skin = typeof d.skin === 'string' ? d.skin : null;
      const SK = require('./skins');
      const askMojang = !skin && !d.bedrock && /^[0-9a-f-]{36}$/i.test(String(d.uuid || '')); // an older mod: ask Mojang by UUID
      if (!skin && !askMojang && !s.postQ) { G.postFromGame(iid, op, d); return; }
      s.postQ = (s.postQ || Promise.resolve()).then(async () => {
        const url = skin || (askMojang ? await SK.skinOfUuid(d.uuid) : null);
        if (url) d._head = await SK.headFor(url).catch(() => null) || undefined;
        G.postFromGame(iid, op, d);
      }).catch(e => console.error('[game] post', e.message)).finally(() => { if (s.postQ === q) s.postQ = null; });
      const q = s.postQ;
      return;
    }
    case 'console.log': {
      const r = ringOf(iid);
      const t = now();
      const sec = Math.floor(t / 1000);
      if (r.frameSec !== sec) { r.frameSec = sec; r.frames = 0; }
      if (++r.frames > 10) return; // 10 frames / s
      if (r.sec !== sec) { r.sec = sec; r.inSec = 0; }
      const out = [];
      if (r.skipped && r.inSec === 0) { out.push(addLine(iid, { kind: 'log', level: 'WARN', logger: 'Ember', msg: `[... ${r.skipped} lines skipped]` })); r.skipped = 0; }
      for (const x of (Array.isArray(d.lines) ? d.lines : []).slice(0, 200)) {
        if (r.inSec >= 40) { r.skipped++; continue; } // 40 lines / s
        r.inSec++;
        const lvl = String(x?.level || 'INFO').toUpperCase().slice(0, 8);
        out.push(addLine(iid, { kind: 'log', t: Number(x?.t) || t, level: /^[A-Z]+$/.test(lvl) ? lvl : 'INFO', logger: clampStr(x?.logger, 60), msg: String(x?.msg ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 2000) }));
      }
      G.broadcastConsole(iid, out);
      return;
    }
    case 'console.result': {
      const p = pending.get(String(d.req || ''));
      if (!p || p.iid !== iid) return;
      pending.delete(String(d.req));
      clearTimeout(p.timer);
      const output = (Array.isArray(d.output) ? d.output : []).slice(0, 100).map(x => String(x ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 2000));
      p.resolve({ ok: d.ok === true, output, truncated: !!d.truncated || (Array.isArray(d.output) && d.output.length > 100), error: d.ok === true ? undefined : clampStr(d.error, 40) || 'error' });
      return;
    }
    case 'console.command': {
      const r = ringOf(iid);
      r.cmdTimes = r.cmdTimes.filter(x => now() - x < 10000);
      if (r.cmdTimes.length >= 20) { r.cmdSkipped++; return; }
      r.cmdTimes.push(now());
      const source = d.source === 'rcon' ? 'rcon' : 'console';
      const command = String(d.command ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 1000);
      if (!command) return;
      const by = clampStr(d.by, 40) || (source === 'rcon' ? 'RCON' : 'CONSOLE');
      const out = [];
      if (r.cmdSkipped) { out.push(addLine(iid, { kind: 'log', level: 'WARN', logger: 'Ember', msg: `[... ${r.cmdSkipped} commands not shown]` })); r.cmdSkipped = 0; }
      out.push(addLine(iid, { kind: 'command', t: Number(d.t) || now(), source, by, command }));
      G.broadcastConsole(iid, out);
      const link = G.linkOfIid(iid);
      if (link) G.audit(link.community_id, iid, null, 'command', `[${source === 'rcon' ? 'RCON' : 'CONSOLE'}] ${command}`, 'local', null);
      return;
    }
    case 'link': return linkFrom(s, d, id);
    case 'unlink': {
      if (!G.linkOfIid(iid)) { frame(s.sock, 'error', { code: 'not_linked', message: 'This server is not linked to Ember.', fatal: false }); return; }
      G.unlink(iid, 'console', null);
      return;
    }
    default:
      frame(s.sock, 'error', { code: 'bad_op', message: `Unknown op ${String(op).slice(0, 30)}`, fatal: false });
  }
}

// the server icon: a PNG (<= 48 KB, <= 1024 px). Velora resizes it to 64x64; without an image library we keep it as sent.
function saveIcon(s, d) {
  const fail = () => { db.run('UPDATE game_instances SET icon_url = NULL, icon_sha256 = NULL WHERE iid = ?', s.iid); s.inst.icon_url = null; s.inst.icon_sha256 = null; };
  try {
    const buf = Buffer.from(String(d.png || ''), 'base64');
    if (!buf.length || buf.length > 48 * 1024 || !buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || buf.length < 24) return fail();
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    if (!w || !h || w > 1024 || h > 1024) return fail();
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    s.inst.icon_url = G.saveIcon(s.iid, buf, s.iconSha || sha);
    s.inst.icon_sha256 = s.iconSha || sha;
    statusChanged(s.iid);
  } catch (e) { console.error('[game-gw] icon', e.message); try { fail(); } catch { /* closed */ } }
}

function onClose(s) {
  sockets.delete(s.sock);
  clearTimeout(s.identifyTimer);
  const n = (perIp.get(s.ipHash) || 1) - 1;
  if (n <= 0) perIp.delete(s.ipHash); else perIp.set(s.ipHash, n);
  if (!s.iid || sessions.get(s.iid) !== s) return;
  sessions.delete(s.iid);
  for (const [req, p] of pending) if (p.iid === s.iid) { clearTimeout(p.timer); pending.delete(req); p.resolve({ ok: false, error: 'offline' }); }
  if (!db.raw()) return; // shutting down
  const l = liveOf(s.iid);
  l.last_seen = now();
  persistSoon(s.iid);
  // servers restart quickly: wait 60 s before calling it offline (unless it said server_stop first)
  if (l.stopped) { setOnline(s.iid, false); return; }
  clearTimeout(l.offlineTimer);
  l.offlineTimer = setTimeout(() => { if (!sessions.has(s.iid) && db.raw()) setOnline(s.iid, false); }, OFFLINE_GRACE);
  l.offlineTimer.unref?.();
}

// ---------------------------------------------------------------- lifecycle
function handleUpgrade(req, socket, head) {
  if (!wss) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => connection(ws, req));
}
function start() {
  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  clearInterval(sweeper);
  sweeper = setInterval(() => {
    const t = now();
    for (const [k, v] of rate) if (!v.length || t - v[v.length - 1] > 3600000) rate.delete(k);
    for (const [k, c] of claims) if (t > c.exp + 10 * 60 * 1000) claims.delete(k);
    const ids = [...sessions.values()].filter(x => x.ready).map(x => x.iid);
    for (const iid of ids) { try { db.run('UPDATE game_instances SET last_seen = ? WHERE iid = ?', t, iid); } catch { /* closed */ } } // the 30-day purge goes by it
  }, 5 * 60 * 1000);
  sweeper.unref();
}
function shutdown() {
  clearInterval(sweeper);
  for (const iid of live.keys()) { const l = live.get(iid); clearTimeout(l.offlineTimer); clearTimeout(l.statusTimer); if (l.persistTimer) { clearTimeout(l.persistTimer); l.persistTimer = null; persist(iid); } }
  for (const p of pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, error: 'offline' }); }
  pending.clear();
  for (const sock of sockets) close(sock, 1001, 'shutdown');
  for (const sock of sockets) setTimeout(() => { try { sock.terminate(); } catch { /* gone */ } }, 500).unref?.();
  sessions.clear();
  wss?.close();
  wss = null;
}
function forget(iid) { live.delete(iid); consoles.delete(iid); }
function sessionOf(iid) { const s = sessions.get(iid); return s?.ready ? { iid, startedAt: s.startedAt, features: s.features, tag: s.tag } : null; }

const _test = { set(o) { Object.assign(T, o); }, reset() { Object.assign(T, { listMinAge: 10000, excessMs: 10000, newPerIpDay: 5, newPerHour: 200, socketsPerIp: 10 }); rate.clear(); }, sessions, claims };

module.exports = {
  start, shutdown, handleUpgrade, connection, sessionOf, send, exec, consoleLines, statusOf, liveOf, pushConfig, unclaimed, createClaim, claimState,
  linkConnected, isConnected, forget, PROTOCOL, LIMITS, _test,
};
