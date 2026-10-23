'use strict';
// WebSocket gateway (PROTOCOL §7): auth handshake, chat_* frames, per-community fan-out filtered by channel visibility.
const { WebSocketServer } = require('ws');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const { err, limiter, log } = require('./util');
const { P } = require('./perms');

const C = () => require('./communities');
const M = () => require('./messages');
const V = () => require('./voice');

const subs = new Map();   // communityId -> Set<socket>   (sockets that said chat_hello and whose user is a member)
const byUser = new Map(); // userId -> Set<socket>        (authenticated sockets)
const all = new Set();
let wss = null, heartbeat = null, cfgHooked = false;
const AUTH_TIMEOUT = 10000, IDLE_MS = 60000, MAX_FPS = 30;

const send = (sock, obj) => { if (sock.readyState === 1) { try { sock.send(JSON.stringify(obj)); } catch { /* closing */ } } };
const authed = sock => sock.bf?.authed;

function subscribe(userId, communityId) {
  for (const sock of byUser.get(Number(userId)) || []) if (sock.bf.ready) { if (!subs.has(communityId)) subs.set(communityId, new Set()); subs.get(communityId).add(sock); }
}
function unsubscribe(userId, communityId) {
  const set = subs.get(communityId);
  if (!set) return;
  for (const sock of byUser.get(Number(userId)) || []) set.delete(sock);
  if (!set.size) subs.delete(communityId);
}
const dropCommunity = id => subs.delete(id);

// everyone subscribed to the community who may see the event (channel events go only to members who can view that channel)
function emit(communityId, obj, { except = null, filter = null } = {}) {
  // `__via` (the page a message was sent from) rides along only to members with Manage users
  let via = null;
  if (obj.__via !== undefined) { via = obj.__via; const { __via, ...rest } = obj; obj = rest; }
  try { require('./bots').dispatch(communityId, obj); } catch (e) { console.error('[gateway] bots', e.message); } // bots get the same events (Discord shape)
  const set = subs.get(communityId);
  if (!set?.size) return;
  const isChannels = obj.type === 'chat_channels_update';
  const cid = obj.message?.channel || (!isChannels ? obj.channel : null);
  let snap = null, ch = null;
  if (cid || isChannels) {
    snap = C().snapById(communityId);
    if (!snap) return;
    if (cid) { ch = snap.channels.find(x => x.cid === cid); if (!ch) return; }
  }
  const memo = new Map();
  for (const sock of set) {
    if (sock === except || sock.readyState !== 1) continue;
    const uid = sock.bf.user.id;
    if (filter && !filter(uid)) continue;
    if (ch) {
      if (!memo.has(uid)) memo.set(uid, snap.canView(ch, uid));
      if (!memo.get(uid)) continue;
    }
    if (isChannels) {
      if (!memo.has(uid)) memo.set(uid, snap.isMember(uid) ? new Set(snap.visible(uid).map(x => x.cid)) : new Set());
      const vis = memo.get(uid);
      send(sock, { ...obj, channels: obj.channels.filter(x => vis.has(x.cid)) });
      continue;
    }
    if (via && obj.message && (snap || (snap = C().snapById(communityId)))?.can(uid, P.MANAGE_USERS)) { send(sock, { ...obj, message: { ...obj.message, via } }); continue; }
    send(sock, obj);
  }
}
const emitWhere = (communityId, obj, pred) => emit(communityId, obj, { filter: pred });
function pushToUser(userId, obj) { for (const sock of byUser.get(Number(userId)) || []) send(sock, obj); }
function pushToAdmins(obj) { for (const [uid, set] of byUser) { const u = set.values().next().value?.bf?.user; if (u && auth.isAdmin(u)) for (const sock of set) send(sock, obj); } }
function broadcastAll(obj) { for (const sock of all) if (authed(sock)) send(sock, obj); }

function closeAll(code, reason) { for (const sock of all) { try { sock.close(code, reason); } catch { /* gone */ } } }
const onlineUserIds = () => [...byUser.keys()];
const isOnline = userId => (byUser.get(Number(userId))?.size || 0) > 0;

// ---------- frames ----------
const need = type => (/^chat_rtc|^chat_voice/.test(type) ? 'voice' : 'chat');
async function onFrame(sock, msg) {
  const st = sock.bf;
  st.lastSeen = Date.now();
  if (msg.type === 'ping') return send(sock, { type: 'pong' });
  if (!st.authed) {
    if (msg.type !== 'auth') return sock.close(4001, 'auth_required');
    return doAuth(sock, msg);
  }
  if (msg.type === 'auth') return;
  const me = st.user;
  const reply = obj => send(sock, obj);
  try {
    if (/^chat_/.test(String(msg.type)) && !st.scopes.includes(need(msg.type)) && msg.type !== 'chat_hello') {
      return reply({ type: 'chat_error', nonce: msg.nonce, request: msg.type, error: 'insufficient_scope', required_scope: need(msg.type) });
    }
    switch (msg.type) {
      case 'chat_hello': {
        st.ready = true;
        for (const row of db.all('SELECT community_id FROM members WHERE user_id = ?', me.id)) { if (!subs.has(row.community_id)) subs.set(row.community_id, new Set()); subs.get(row.community_id).add(sock); }
        reply({ type: 'chat_ready', you: auth.userView(me) });
        require('./profiles').lazy(me); // picks up a rename done on Velora since the last sign-in
        break;
      }
      case 'chat_send': {
        const ctx = C().findChannel(msg.channel, me);
        const message = await M().postMessage(me, ctx, msg.message, { replyTo: msg.reply_to, attachments: msg.attachments, signature: msg.signature, scopes: st.scopes, origin: st.origin });
        reply({ type: 'chat_ack', nonce: msg.nonce, message });
        break;
      }
      case 'chat_typing': {
        const { ch, c } = C().findChannel(msg.channel, me);
        if (C().getSettings(me).share_typing === false) break;
        const t = Date.now();
        if (t - (st.typingAt || 0) < 1500 && msg.typing !== false) break;
        st.typingAt = t;
        emit(c.id, { type: 'chat_typing', server: c.sid, channel: ch.cid, username: me.username, user_id: me.principal, typing: msg.typing !== false }, { except: sock });
        break;
      }
      case 'voice_sound': { // soundboard: play a sound to everyone in the voice room you're in
        if (!st.scopes.includes('voice')) return reply({ type: 'voice_sound_failed', reason: 'insufficient_scope' });
        const room = V().roomOf(sock), ch = room && V().voiceChannelOf(room);
        if (!ch) return reply({ type: 'voice_sound_failed', reason: 'not_in_voice' });
        const sb = require('./soundboard'), r = msg.sound && typeof msg.sound === 'object' ? sb.external(me, ch.community_id, msg.sound) : sb.playable(me, msg.sound, ch.community_id);
        if (r.error) return reply({ type: 'voice_sound_failed', reason: r.error });
        for (const s of V().socketsIn(room)) send(s, { type: 'voice_sound', by: me.username, channel: ch.cid, sound: r.sound });
        break;
      }
      case 'chat_read': M().markRead(msg.channel, me, msg.message_id ?? msg.id); break;
      default:
        if (/^chat_(rtc|voice)/.test(String(msg.type))) await V().handle(sock, me, msg, reply);
    }
  } catch (e) {
    reply({ type: 'chat_error', nonce: msg.nonce, request: msg.type, error: e.code || 'server_error', ...(e.extra || {}) });
    if (!e.code) console.error('[gateway]', msg.type, e.stack || e.message);
  }
}
function doAuth(sock, msg) {
  const s = auth.resolveSession(msg.session);
  if (!s) return sock.close(4001, 'invalid_session');
  if (s.user.banned) return sock.close(4003, 'banned');
  const st = sock.bf;
  clearTimeout(st.timer);
  Object.assign(st, { authed: true, user: s.user, scopes: s.scopes });
  try { db.run('UPDATE users SET last_connect = ? WHERE id = ?', Date.now(), s.user.id); } catch (e) { console.error('[gateway] last_connect', e.message); }
  if (!byUser.has(s.user.id)) byUser.set(s.user.id, new Set());
  byUser.get(s.user.id).add(sock);
  const admin = auth.isAdmin(s.user), quota = admin ? require('./relay/client').voiceQuota() : null;
  send(sock, { type: 'auth_success', user: auth.userView(s.user), instance_admin: admin, instance_owner: auth.isOwner(s.user), ...(quota ? { voice_quota: quota } : {}) });
}

function onConnection(sock, req) {
  sock.bf = { origin: req?.headers?.origin || null, authed: false, ready: false, lastSeen: Date.now(), frames: [] };
  all.add(sock);
  sock.bf.timer = setTimeout(() => { if (!sock.bf.authed) sock.close(4001, 'auth_timeout'); }, AUTH_TIMEOUT);
  const fps = limiter(MAX_FPS, 1000);
  sock.on('message', raw => {
    if (!fps.hit('x')) return sock.close(4008, 'rate_limited');
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    onFrame(sock, msg).catch(e => console.error('[gateway] frame', e.message));
  });
  sock.on('close', () => {
    clearTimeout(sock.bf.timer);
    all.delete(sock);
    const uid = sock.bf.user?.id;
    if (uid != null) { const set = byUser.get(uid); set?.delete(sock); if (set && !set.size) byUser.delete(uid); }
    for (const [id, set] of subs) { set.delete(sock); if (!set.size) subs.delete(id); }
    if (db.raw()) try { V().leave(sock); } catch (e) { console.error('[gateway] voice leave', e.message); }
  });
  sock.on('error', () => {});
}

function attach(httpServer) {
  wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  wss.on('connection', onConnection);
  httpServer.on('upgrade', (req, socket, head) => {
    let p = ''; try { p = new URL(req.url, 'http://x').pathname; } catch { /* bad url */ }
    if (p === '/bot/gateway') return require('./bots').handleUpgrade(req, socket, head); // Discord-style bot gateway
    if (p === '/game-gateway') return require('./game').handleUpgrade(req, socket, head); // Ember Link (Minecraft), PROTOCOL §18
    if (p !== '/gateway') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  heartbeat = setInterval(() => { const t = Date.now(); for (const s of all) if (t - s.bf.lastSeen > IDLE_MS) s.terminate(); }, 15000);
  heartbeat.unref();
  if (!cfgHooked) { cfgHooked = true; config.events.on('change', () => broadcastAll({ type: 'instance_update', settings: config.publicView() })); }
}
function shutdown(code = 1001, reason = 'shutdown') {
  clearInterval(heartbeat);
  closeAll(code, reason);
  require('./bots').shutdown();
  for (const s of all) setTimeout(() => s.terminate(), 500).unref();
  wss?.close();
}

module.exports = { attach, shutdown, send, subscribe, unsubscribe, dropCommunity, emit, emitWhere, pushToUser, pushToAdmins, broadcastAll, closeAll, onlineUserIds, isOnline };
