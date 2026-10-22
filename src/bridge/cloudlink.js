'use strict';
// CloudLink bridge (ported from Velora's cloudlink-bridge.js; PROTOCOL §17): a `logs` channel with config.mode = 'cloudlink'
// is joined to a CloudLink 4 WebSocket server's chat. The instance holds one socket per bridge channel (reconnects with
// backoff) and relays both ways:
//   - handshake = {"cmd":"handshake"}; then setid (when a username is set) and link (when a room is set)
//   - chat = "gmsg" packets whose val is "Name: text" ("[Discord] Name: ..." / "Fluxer | Name: ..." from other bridges)
//   - here -> CloudLink = {"cmd":"gmsg","val":"Ember | name: text"}; the server echoes it back, and we skip it once
//   - "!online" in the channel answers with the CloudLink user list (from ulist) and is not forwarded
//   - the gmsg a server replays right after the handshake is skipped
// Nothing from CloudLink can ping anyone: every @ gets a zero-width space after it.
// The URL is user-supplied: ws: / wss: only, ports 80 / 443, no private / LAN / loopback addresses (checked again after
// DNS, on every connect). BONFIRE_DEV=1 allows ws://localhost, private addresses and other ports (development only).
const WebSocket = require('ws');
const dns = require('dns');
const net = require('net');
const db = require('../db');
const { isPrivateIp } = require('../unfurl');
const { P } = require('../perms');
const { err } = require('../util');

const C = () => require('../communities');
const M = () => require('../messages');

const DEFAULT_URL = 'wss://ikelene.net/cl/';
const OFFICIAL_HOSTS = new Set(['ikelene.net', 'www.ikelene.net', 'velora.ikelene.net']);
const MAX_PER_COMMUNITY = 3;
const PREFIX = 'Ember | ';
const OUT_MAX = 1000;          // characters per message sent to CloudLink
const IN_MAX = 2000;           // characters per message posted here
const IN_BURST = [8, 10e3];    // at most 8 inbound messages per 10 s per channel...
const IN_MINUTE = [40, 60e3];  // ...and 40 per minute
const OUT_BURST = [15, 10e3];  // here -> CloudLink per channel
const ZW = '\u200b';
const dev = () => process.env.BONFIRE_DEV === '1';

// ---- config ----
const cfgOf = ch => { const c = ch?.config; if (c && typeof c === 'object') return c; try { return JSON.parse(c || '{}') || {}; } catch { return {}; } };
const isCloudlink = ch => !!ch && ch.type === 'logs' && cfgOf(ch).mode === 'cloudlink';
function isOfficial(u) {
  return OFFICIAL_HOSTS.has(u.hostname.toLowerCase()) && u.protocol === 'wss:' && (!u.port || u.port === '443') && /^\/cl\/?$/.test(u.pathname) && !u.search;
}
// a URL someone typed -> a clean one, or an error (sync checks; DNS is checked when connecting)
function cleanUrl(v) {
  const s = String(v ?? '').trim();
  if (!s) return DEFAULT_URL;
  if (s.length > 300) throw err('cl_bad_url');
  let u;
  try { u = new URL(s); } catch { throw err('cl_bad_url'); }
  if (!['ws:', 'wss:'].includes(u.protocol)) throw err('cl_bad_url');
  if (u.username || u.password) throw err('cl_bad_url');
  if (!dev() && u.port && !['80', '443'].includes(u.port)) throw err('cl_bad_port');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw err('cl_bad_url');
  if (!dev()) {
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa')) throw err('cl_private_address');
    if (net.isIP(host) && isPrivateIp(host)) throw err('cl_private_address');
    if (!net.isIP(host) && /^[0-9.]+$|^0x/i.test(host)) throw err('cl_private_address'); // numeric spellings (2130706433, 0x7f.1)
  }
  u.hash = '';
  return u.href;
}
const plain = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
// communities.cleanConfig delegates here for logs channels: {} = plain webhooks channel
function cleanChannelConfig(raw, snap, me, current = null) {
  raw = raw && typeof raw === 'object' ? raw : {};
  if (raw.mode !== 'cloudlink') return {};
  require('../managed').assertAllows('bridges');
  if (!snap.can(me.id, P.MANAGE_CHANNELS)) throw err('not_allowed', 403);
  const others = snap.channels.filter(ch => isCloudlink(ch) && (!current || ch.id !== current.id)).length;
  if (others >= MAX_PER_COMMUNITY) throw err('too_many_cloudlink_bridges');
  return { mode: 'cloudlink', url: cleanUrl(raw.url), room: plain(raw.room, 60), username: plain(raw.username, 40).replace(/:/g, '') };
}
function publicChannelConfig(ch) {
  const cfg = cfgOf(ch);
  if (cfg.mode !== 'cloudlink') return {};
  let official = false;
  try { official = isOfficial(new URL(cfg.url || DEFAULT_URL)); } catch { /* bad url */ }
  return { mode: 'cloudlink', url: cfg.url || DEFAULT_URL, room: cfg.room || '', username: cfg.username || '', official };
}
// import: a cloudlink config from an export (no permission context) -> a safe one, or {} when the URL isn't acceptable here
function importConfig(cfg) {
  if (!cfg || cfg.mode !== 'cloudlink') return {};
  try { return { mode: 'cloudlink', url: cleanUrl(cfg.url), room: plain(cfg.room, 60), username: plain(cfg.username, 40).replace(/:/g, '') }; } catch { return {}; }
}

// ---- safe DNS: refuse when any address is private (the same rule as link previews) ----
let resolver = (host, cb) => dns.lookup(host, { family: 0, all: true }, cb);
function safeLookup(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  resolver(host, (e, list) => {
    if (e) return cb(e);
    list = Array.isArray(list) ? list : [];
    const ok = dev() ? list : list.filter(x => !isPrivateIp(x.address));
    if (!ok.length || ok.length !== list.length) return cb(Object.assign(new Error('private_address'), { code: 'EPRIVATE' }));
    if (opts && opts.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

// ---- text both ways ----
function textIn(t) {
  return String(t ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').slice(0, IN_MAX)
    .replace(/<@/g, `<${ZW}@`).replace(/@/g, `@${ZW}`).trim();
}
// "Name: text" -> who sent it (+ which bridge it came through) and what they said
function parseGmsg(val) {
  const i = val.indexOf(':');
  let name = i > 0 ? val.slice(0, i).trim() : '';
  const text = i > 0 ? val.slice(i + 1).trim() : '';
  if (!name || !text || name.length > 64) return { name: null, text: val.trim(), from: null };
  let from = null;
  if (name.startsWith('[Discord]')) { from = 'Discord'; name = name.slice(9).trim(); }
  else if (name.startsWith('Fluxer | ')) { from = 'Fluxer'; name = name.slice(9).trim(); }
  else if (name.startsWith(PREFIX)) { from = 'Ember'; name = name.slice(PREFIX.length).trim(); }
  name = plain(name, 40);
  return name ? { name, text, from } : { name: null, text: val.trim(), from: null };
}
function textOut(ctx, msg) {
  let t = String(msg.body || '');
  t = t.replace(/<@&(r[0-9a-f]{10})>/g, (_, rid) => `@${ctx.snap.roles.find(r => r.rid === rid)?.name || 'role'}`);
  t = t.replace(/<a?:(\w+):e[0-9a-f]{10}>/g, (_, n) => `:${n}:`);
  for (const a of msg.attachments || []) if (a?.url) t += ` ${a.url}`;
  if (msg.reply?.author?.username) t = `(replying to ${msg.reply.author.username}) ${t}`;
  t = t.replace(/\s*\n\s*/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return t.length > OUT_MAX ? `${t.slice(0, OUT_MAX - 3)}...` : t;
}
const within = (list, [n, ms], t) => { while (list.length && t - list[0] > ms) list.shift(); return list.length < n; };

// ---- one connection per bridge channel ----
const conns = new Map(); // channel id -> Conn
const keyOf = cfg => `${cfg.url}|${cfg.room}|${cfg.username || (cfg.room ? 'Ember' : '')}`;
class Conn {
  constructor(ch) {
    const cfg = publicChannelConfig(ch);
    this.channelId = ch.id;
    this.url = cfg.url; this.room = cfg.room;
    this.username = cfg.username || (cfg.room ? 'Ember' : '');
    this.key = keyOf(cfg);
    this.state = 'connecting'; this.error = null; this.since = Date.now(); this.attempts = 0;
    this.online = new Map(); this.echo = new Map();
    this.inTimes = []; this.inMinute = []; this.outTimes = [];
    this.skipped = 0; this.skipNoteAt = 0; this.lastIn = null; this.lastOut = null;
    this.stopped = false; this.ws = null;
    this.open();
  }
  setState(state, error = null) { this.state = state; this.error = error; this.since = Date.now(); }
  open() {
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.ready = false;
    this.steps = [];
    if (this.username) this.steps.push({ cmd: 'setid', val: this.username, listener: 'bonfire_setid' });
    if (this.room) this.steps.push({ cmd: 'link', val: this.room, listener: 'bonfire_link' });
    let target;
    try { target = cleanUrl(this.url); } catch (e) { return this.fail(e.code || 'cl_bad_url', true); } // re-checked on every connect (dev mode may be off now)
    this.setState('connecting');
    let ws;
    try {
      ws = new WebSocket(target, {
        handshakeTimeout: 10e3, maxPayload: 512 * 1024, followRedirects: false, perMessageDeflate: false,
        headers: { 'User-Agent': 'Bonfire-CloudLink/1.0' }, lookup: safeLookup,
      });
    } catch { return this.fail('cl_bad_url', true); }
    this.ws = ws;
    ws.on('open', () => {
      if (this.stopped) return ws.close();
      this.setState('handshaking');
      this.openedAt = Date.now();
      this.send({ cmd: 'handshake' });
      this.readyTimer = setTimeout(() => this.markReady(), 8e3); // a server that never answers the handshake is still used
      this.readyTimer.unref?.();
      this.alive = true;
      this.pinger = setInterval(() => { if (!this.alive) return ws.terminate(); this.alive = false; try { ws.ping(); } catch { /* closing */ } }, 30e3);
      this.pinger.unref?.();
    });
    ws.on('pong', () => { this.alive = true; });
    ws.on('message', (raw, isBinary) => {
      if (isBinary || this.stopped) return;
      let p; try { p = JSON.parse(String(raw)); } catch { return; }
      if (p && typeof p === 'object') this.onPacket(p);
    });
    ws.on('unexpected-response', (req, res) => { res.resume(); this.closeReason = `http_${res.statusCode}`; });
    ws.on('error', e => { this.closeReason = e.code === 'EPRIVATE' ? 'cl_private_address' : e.code || e.message; });
    ws.on('close', () => {
      clearInterval(this.pinger); clearTimeout(this.readyTimer);
      if (this.ws === ws) this.ws = null;
      this.ready = false; this.online.clear();
      if (this.stopped) return;
      if (this.openedAt && Date.now() - this.openedAt > 60e3) this.attempts = 0;
      this.openedAt = null;
      const reason = this.closeReason || 'closed';
      this.closeReason = null;
      this.fail(reason, reason === 'cl_private_address');
    });
  }
  fail(reason, hard = false) {
    if (this.stopped) return;
    this.attempts++;
    const wait = hard ? 10 * 60e3 : Math.min(5e3 * 2 ** Math.min(this.attempts - 1, 6), 5 * 60e3) + Math.random() * 2e3;
    this.setState('waiting', String(reason || 'closed').slice(0, 80));
    this.retryAt = Date.now() + wait;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.open(), wait);
    this.retry.unref?.();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retry); clearInterval(this.pinger); clearTimeout(this.readyTimer);
    if (this.ws) { const w = this.ws; try { w.close(1000); } catch { /* gone */ } setTimeout(() => { try { w.terminate(); } catch { /* gone */ } }, 3e3).unref?.(); }
    this.setState('stopped');
  }
  send(obj) { if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false; try { this.ws.send(JSON.stringify(obj)); return true; } catch { return false; } }
  markReady() {
    clearTimeout(this.readyTimer);
    if (this.ready) return;
    this.ready = true;
    this.attempts = this.attempts > 0 ? 1 : 0;
    this.setState('connected');
  }
  ourRoom(p) {
    const r = p.rooms;
    if (r === undefined || r === null) return true;
    const want = this.room || 'default';
    return Array.isArray(r) ? r.map(String).includes(want) : String(r) === want;
  }
  onPacket(p) {
    const cmd = String(p.cmd || '');
    if (cmd === 'statuscode') {
      if (this.ready) return;
      const next = this.steps.shift();
      if (next) this.send(next); else this.markReady();
      return;
    }
    if (cmd === 'ulist') {
      if (!this.ourRoom(p)) return;
      const nameOf = v => (v && typeof v === 'object' ? v.username : v);
      const add = v => { const n = nameOf(v); if (n != null && n !== '') this.online.set(String(n), (this.online.get(String(n)) || 0) + 1); };
      if (p.mode === 'set') { this.online.clear(); (Array.isArray(p.val) ? p.val : []).slice(0, 2000).forEach(add); }
      else if (p.mode === 'add') add(p.val);
      else if (p.mode === 'remove') { const n = String(nameOf(p.val) ?? ''); const k = this.online.get(n) || 0; if (k > 1) this.online.set(n, k - 1); else this.online.delete(n); }
      return;
    }
    if (cmd === 'gmsg') {
      if (!this.ready || !this.ourRoom(p) || typeof p.val !== 'string' || !p.val.trim()) return; // before ready = the server's replay
      if (this.takeEcho(p.val)) return;
      const val = p.val;
      this.queue = (this.queue || Promise.resolve()).then(() => this.inbound(val)).catch(e => console.error('[cloudlink] in', e.message));
    }
  }
  takeEcho(val) {
    const t = Date.now();
    const list = (this.echo.get(val) || []).filter(x => x > t);
    if (!list.length) { this.echo.delete(val); return false; }
    list.shift();
    if (list.length) this.echo.set(val, list); else this.echo.delete(val);
    return true;
  }
  channel() { const ch = db.get('SELECT * FROM channels WHERE id = ?', this.channelId); return isCloudlink(ch) ? ch : null; }
  inbound(val) {
    const ch = this.channel();
    if (!ch) return;
    const t = Date.now();
    if (!within(this.inTimes, IN_BURST, t) || !within(this.inMinute, IN_MINUTE, t)) {
      this.skipped++;
      if (t - this.skipNoteAt > 60e3) { this.skipNoteAt = t; try { M().systemMessage(M().ctxOf(ch), 'Some CloudLink messages were skipped (too many at once).', { sysKind: 'cl_skip' }); } catch { /* gone */ } }
      return;
    }
    this.inTimes.push(t); this.inMinute.push(t);
    const g = parseGmsg(val);
    const text = textIn(g.text);
    if (!text) return;
    this.lastIn = t;
    try { M().postBridged(ch, { platform: 'cloudlink', name: g.name || 'CloudLink', avatar: null, body: text, from: g.from }); } catch (e) { console.error('[cloudlink] post', e.message); }
  }
  outbound(ctx, msg) {
    const a = msg.author || {};
    if (msg.system || a.webhook || a.bridge || !a.username) return;
    const body = String(msg.body || '').trim();
    if (body.toLowerCase() === '!online') return this.answerOnline(ctx.ch);
    if (!this.ready) return;
    const t = Date.now();
    if (!within(this.outTimes, OUT_BURST, t)) return;
    const text = textOut(ctx, msg);
    if (!text) return;
    const val = `${PREFIX}${plain(a.username, 40).replace(/:/g, '')}: ${text}`;
    if (!this.send(this.room ? { cmd: 'gmsg', val, rooms: this.room } : { cmd: 'gmsg', val })) return;
    this.outTimes.push(t);
    this.lastOut = t;
    this.echo.set(val, [...(this.echo.get(val) || []), t + 20e3]);
    if (this.echo.size > 200) for (const k of [...this.echo.keys()].slice(0, 100)) this.echo.delete(k);
  }
  answerOnline(ch) {
    const names = [...this.online.keys()].sort((x, y) => x.localeCompare(y));
    let text;
    if (!this.ready) text = "Not connected to CloudLink right now - it'll keep trying.";
    else if (!names.length) text = 'No users currently online in global chat.';
    else text = `**${names.length}** user(s) online: ${names.slice(0, 80).map(n => plain(n, 40)).join(', ')}${names.length > 80 ? ', ...' : ''}`;
    setImmediate(() => { try { M().postBridged(ch, { platform: 'cloudlink', name: 'CloudLink', avatar: null, body: textIn(text) }); } catch (e) { console.error('[cloudlink] online', e.message); } });
  }
  view() {
    const iso = t => (t ? new Date(t).toISOString() : null);
    return {
      state: this.state, error: this.error, since: iso(this.since), retry_at: this.state === 'waiting' ? iso(this.retryAt) : null,
      online: this.online.size, users: [...this.online.keys()].slice(0, 100).map(n => plain(n, 40)),
      last_in: iso(this.lastIn), last_out: iso(this.lastOut), skipped: this.skipped,
    };
  }
}

// ---- keep the connections in line with the channels (boot, channel changes, once a minute) ----
function reconcile() {
  let all;
  try { all = db.all("SELECT * FROM channels WHERE type = 'logs' ORDER BY community_id, position, id"); } catch { return; }
  const want = new Map(), per = new Map();
  for (const ch of all.filter(isCloudlink)) {
    const n = per.get(ch.community_id) || 0;
    if (n >= MAX_PER_COMMUNITY) continue;
    per.set(ch.community_id, n + 1);
    want.set(ch.id, ch);
  }
  for (const [id, conn] of conns) {
    const ch = want.get(id);
    if (!ch || keyOf(publicChannelConfig(ch)) !== conn.key) { conn.stop(); conns.delete(id); }
  }
  for (const [id, ch] of want) if (!conns.has(id)) conns.set(id, new Conn(ch));
}
let soon = null, timer = null, unhook = [];
function channelsChanged() { clearTimeout(soon); soon = setTimeout(reconcile, 300); soon.unref?.(); }
function onPost(msg, ctx, meta) {
  if (meta.system || meta.webhook || meta.bridged || ctx.ch.type !== 'logs') return;
  const conn = conns.get(ctx.ch.id);
  if (conn && isCloudlink(ctx.ch)) { try { conn.outbound(ctx, msg); } catch (e) { console.error('[cloudlink] out', e.message); } }
}
function status(ch) {
  const conn = conns.get(ch.id);
  if (conn) return { ...publicChannelConfig(ch), ...conn.view() };
  return { ...publicChannelConfig(ch), state: isCloudlink(ch) ? 'off' : 'not_a_bridge', error: isCloudlink(ch) ? 'over_limit' : null, online: 0, users: [] };
}
function reconnect(ch) {
  const conn = conns.get(ch.id);
  if (!conn) return status(ch);
  conn.attempts = 0;
  if (conn.ws) { try { conn.ws.terminate(); } catch { /* gone */ } } else conn.open();
  return status(ch);
}
// Manage channels + a CloudLink logs channel (routes)
function bridgeChannel(cid, me) {
  const r = C().findChannel(cid, me);
  if (!r.snap.can(me.id, P.MANAGE_CHANNELS)) throw err('not_allowed', 403);
  if (!isCloudlink(r.ch)) throw err('not_a_cloudlink_bridge', 400);
  return r.ch;
}
function init() {
  unhook.forEach(f => f());
  unhook = [M().onPost(onPost), C().onChannelsChanged(channelsChanged)];
  reconcile();
  clearInterval(timer);
  timer = setInterval(reconcile, 60e3);
  timer.unref();
}
function shutdown() {
  clearInterval(timer); clearTimeout(soon);
  unhook.forEach(f => f()); unhook = [];
  for (const conn of conns.values()) conn.stop();
  conns.clear();
}

module.exports = {
  init, shutdown, reconcile, channelsChanged, cleanChannelConfig, publicChannelConfig, importConfig, isCloudlink, status, reconnect, bridgeChannel,
  DEFAULT_URL, MAX_PER_COMMUNITY,
  _test: { cleanUrl, parseGmsg, textIn, isOfficial, safeLookup, conns, setResolver(fn) { resolver = fn; }, resetResolver() { resolver = (host, cb) => dns.lookup(host, { family: 0, all: true }, cb); } },
};
