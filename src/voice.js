'use strict';
// Voice over Cloudflare Realtime (PROTOCOL §10): ported from Velora's cf-realtime.js + the chat_rtc_* handlers in chat.js.
// The client never sees the SFU app secret, only expiring ICE credentials and SDP. Rooms are named bf_<cid>.
const config = require('./config');
const db = require('./db');
const C = require('./communities');
const { P } = require('./perms');
const { err, clean } = require('./util');

const gw = () => require('./gateway');
const BASE = 'https://rtc.live.cloudflare.com/v1';

// ---------- Cloudflare Realtime boundary ----------
let httpFetch = (...a) => fetch(...a); // injectable for tests
const setFetch = fn => { httpFetch = fn || ((...a) => fetch(...a)); iceCache = null; };
const cf = () => config.get().voice;
const configured = () => config.voiceConfigured();
async function request(url, token, method = 'POST', body) {
  const res = await httpFetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errorCode || json.errors?.length) throw Object.assign(new Error(json.errorCode || json.errors?.[0]?.message || `realtime_${res.status}`), { code: 'realtime_upstream', status: res.status });
  return json;
}
const app = (p, method, body) => request(`${BASE}/apps/${cf().cf_app_id}${p}`, cf().cf_app_secret, method, body);
const R = {
  createSession: async () => (await app('/sessions/new')).sessionId,
  publish: (id, sessionDescription, tracks) => app(`/sessions/${encodeURIComponent(id)}/tracks/new`, 'POST', { sessionDescription, tracks }),
  subscribe: (id, tracks) => app(`/sessions/${encodeURIComponent(id)}/tracks/new`, 'POST', { tracks }),
  renegotiate: (id, sessionDescription) => app(`/sessions/${encodeURIComponent(id)}/renegotiate`, 'PUT', { sessionDescription }),
  closeTracks: (id, mids) => app(`/sessions/${encodeURIComponent(id)}/tracks/close`, 'PUT', { tracks: mids.map(mid => ({ mid })), force: true }),
  // the Connection API has no session DELETE: force-close every media flow; Cloudflare reclaims idle sessions itself
  async closeSession(id) {
    if (!id || !configured()) return;
    const info = await app(`/sessions/${encodeURIComponent(id)}`, 'GET');
    const mids = (info.tracks || []).filter(t => t?.mid != null && t.status !== 'inactive').map(t => String(t.mid));
    if (mids.length) return R.closeTracks(id, mids);
  },
};
let iceCache = null;
async function iceServers(ttl = 14400) { // credentials live 4h; hand out one set for 30 min
  if (iceCache && Date.now() - iceCache.at < 30 * 60 * 1000) return iceCache.servers;
  const v = cf();
  const out = await request(`${BASE}/turn/keys/${encodeURIComponent(v.cf_turn_key_id)}/credentials/generate-ice-servers`, v.cf_turn_token, 'POST', { ttl: Math.max(600, Math.min(86400, ttl)) });
  if (!Array.isArray(out.iceServers)) throw Object.assign(new Error('turn_upstream'), { code: 'turn_upstream' });
  iceCache = { at: Date.now(), servers: out.iceServers };
  return iceCache.servers;
}

// ---------- rooms ----------
const voiceIn = new Map();   // room -> Map(userId -> { id, username, muted, deafened, since })
const rtcRooms = new Map();  // room -> Map(socket -> participant); socket identity keeps one tab from removing another
const rtcBySocket = new WeakMap();
const rtcOf = room => { if (!rtcRooms.has(room)) rtcRooms.set(room, new Map()); return rtcRooms.get(room); };
const rtcPublic = room => {
  const live = [...(rtcRooms.get(room) || new Map()).values()].filter(p => p.connected);
  return live.map(p => {
    const seen = new Map(); // everyone subscribed to this person's screen track (one entry per account)
    for (const q of live) if (q !== p && q.userId !== p.userId && (q.subscriptions || []).some(x => x.sessionId === p.publish && x.trackName === 'screen')) seen.set(q.userId, { userId: q.principal, username: q.username });
    return { userId: p.principal, username: p.username, tracks: p.tracks, watchers: [...seen.values()] };
  });
};
const rtcBroadcast = room => { const payload = { type: 'chat_rtc_room', room, people: rtcPublic(room) }; for (const p of rtcOf(room).values()) gw().send(p.sock, payload); };

const VOICE_ROOM = /^bf_(c[0-9a-f]{10})$/;
function voiceChannelOf(room) {
  const m = VOICE_ROOM.exec(String(room || ''));
  const ch = m && db.get("SELECT * FROM channels WHERE cid = ? AND type = 'voice'", m[1]);
  return ch || null;
}
const voiceUsers = room => [...(voiceIn.get(room) || new Map()).values()].map(v => ({ id: v.id, username: v.username, muted: v.muted, deafened: v.deafened, since: v.since }));
const stateOf = channels => Object.fromEntries(channels.filter(c => c.type === 'voice').map(c => [c.cid, voiceUsers(`bf_${c.cid}`)]));
function voiceChanged(room) {
  const ch = voiceChannelOf(room);
  if (!ch) return;
  const c = db.get('SELECT * FROM communities WHERE id = ?', ch.community_id);
  gw().emit(c.id, { type: 'chat_voice_state', server: c.sid, channel: ch.cid, users: voiceUsers(room) });
}
const voiceJoined = (p, room) => { if (!voiceIn.has(room)) voiceIn.set(room, new Map()); voiceIn.get(room).set(p.userId, { id: p.principal, username: p.username, muted: false, deafened: false, since: Date.now() }); voiceChanged(room); };
const voiceLeft = (p, room) => { const m = voiceIn.get(room); if (!m?.delete(p.userId)) return; if (!m.size) voiceIn.delete(room); voiceChanged(room); };

// may this person join this room? (null = yes, otherwise why not)
function voiceDenied(me, room) {
  const ch = voiceChannelOf(room);
  if (!ch) return 'not_allowed';
  const snap = C.snapById(ch.community_id);
  if (!snap.isMember(me.id)) return 'not_a_member';
  if (!snap.canView(ch, me.id) || !(snap.chPerms(ch, me.id) & P.SEND)) return 'not_allowed';
  const limit = Number(C.cfgOf(ch).user_limit) || 0;
  const here = voiceIn.get(room);
  if (limit && here && here.size >= limit && !here.has(me.id) && !snap.can(me.id, P.MANAGE_CHANNELS)) return 'channel_full';
  return null;
}

function leave(sock) {
  const p = rtcBySocket.get(sock);
  if (!p) return;
  rtcBySocket.delete(sock);
  const people = rtcRooms.get(p.room);
  people?.delete(sock);
  if (!people?.size) rtcRooms.delete(p.room); else rtcBroadcast(p.room);
  // only drop the voice-state entry when no other tab of the same account is still connected in the room
  const stillThere = [...(people?.values() || [])].some(q => q.userId === p.userId && q.connected);
  if (p.connected && !stillThere) voiceLeft(p, p.room);
  if (configured()) Promise.allSettled([R.closeSession(p.publish), R.closeSession(p.receive)]).catch(() => {});
}
function allocated(requested, results) {
  const remaining = (results || []).filter(r => r && r.mid != null && !r.errorCode && !r.error);
  return requested.map(t => {
    let i = remaining.findIndex(r => r.trackName === t.trackName && (!t.sessionId || !r.sessionId || r.sessionId === t.sessionId));
    if (i < 0) i = remaining.findIndex(r => r.trackName === t.trackName);
    if (i < 0) return null;
    const result = remaining.splice(i, 1)[0];
    return { ...t, mid: String(result.mid), sessionId: result.sessionId || t.sessionId };
  }).filter(Boolean);
}
const validDescription = d => d && (d.type === 'offer' || d.type === 'answer') && typeof d.sdp === 'string' && d.sdp.length > 20 && d.sdp.length < 200000;

// -> true when the frame was a voice frame (handled; errors are thrown to the gateway, which sends chat_error)
async function handle(sock, me, msg, reply) {
  switch (msg.type) {
    case 'chat_rtc_join': {
      const room = String(msg.room || '');
      const denied = voiceDenied(me, room);
      if (denied) throw err(denied, 403);
      if (!configured()) throw err('voice_unavailable', 503);
      leave(sock);
      const [publish, receive, ice] = await Promise.all([R.createSession(), R.createSession(), iceServers()]);
      // keep negotiating participants private until their browser confirms a real WebRTC connection
      const p = { sock, userId: me.id, principal: me.principal, username: me.username, room, publish, receive, tracks: [], subscriptions: [], connected: false };
      rtcBySocket.set(sock, p); rtcOf(room).set(sock, p);
      reply({ type: 'chat_rtc_joined', nonce: msg.nonce, room, iceServers: ice, people: rtcPublic(room) });
      return true;
    }
    case 'chat_rtc_publish': {
      const p = rtcBySocket.get(sock);
      if (!p || p.room !== String(msg.room || '') || !validDescription(msg.sessionDescription) || !Array.isArray(msg.tracks)) throw err('not_in_voice', 400);
      const names = new Set();
      const tracks = msg.tracks.slice(0, 4).map(t => ({ location: 'local', mid: clean(t?.mid, 32), trackName: clean(t?.trackName, 40) }))
        .filter(t => t.mid && /^(audio|camera|screen|screen_audio)$/.test(t.trackName) && !names.has(t.trackName) && names.add(t.trackName));
      if (!tracks.length) throw err('no_tracks', 400);
      const out = await R.publish(p.publish, msg.sessionDescription, tracks);
      // a 200 can still hold an error for one allocation: only advertise tracks Cloudflare accepted
      const accepted = allocated(tracks, out.tracks);
      if (!accepted.length) throw err('realtime_track_rejected', 502);
      const next = accepted.map(t => ({ ...t, kind: t.trackName === 'audio' || t.trackName === 'screen_audio' ? 'audio' : 'video' }));
      p.tracks = [...p.tracks.filter(old => !next.some(t => t.trackName === old.trackName)), ...next];
      reply({ type: 'chat_rtc_published', nonce: msg.nonce, room: p.room, sessionDescription: out.sessionDescription, tracks: p.tracks });
      if (p.connected) rtcBroadcast(p.room);
      return true;
    }
    case 'chat_rtc_connected': {
      const p = rtcBySocket.get(sock);
      if (!p || p.room !== String(msg.room || '')) throw err('not_in_voice', 400);
      if (!p.connected) { p.connected = true; rtcBroadcast(p.room); voiceJoined(p, p.room); }
      return true;
    }
    case 'chat_rtc_subscribe': {
      const p = rtcBySocket.get(sock);
      if (!p || p.room !== String(msg.room || '') || !Array.isArray(msg.sources)) throw err('not_in_voice', 400);
      const allowed = rtcOf(p.room);
      const wanted = [], refs = [], seen = new Set();
      for (const source of msg.sources.slice(0, 30)) {
        const owner = [...allowed.values()].find(x => x.principal === String(source?.userId));
        const name = clean(source?.trackName, 40);
        const key = owner && `${owner.publish}:${name}`;
        if (owner && owner.sock !== sock && owner.tracks.some(t => t.trackName === name) && !seen.has(key)) { seen.add(key); refs.push({ userId: owner.principal, username: owner.username, sessionId: owner.publish, trackName: name }); }
      }
      // the client sends its authoritative desired subscription snapshot: retire what disappeared first
      const desired = new Set(refs.map(r => `${r.sessionId}:${r.trackName}`));
      const stale = (p.subscriptions || []).filter(s => !desired.has(`${s.sessionId}:${s.trackName}`));
      if (stale.length) await R.closeTracks(p.receive, stale.map(s => s.mid));
      p.subscriptions = (p.subscriptions || []).filter(s => !stale.includes(s));
      const watchChanged = stale.some(s => s.trackName === 'screen');
      for (const ref of refs) if (!p.subscriptions.some(s => s.sessionId === ref.sessionId && s.trackName === ref.trackName)) wanted.push({ location: 'remote', sessionId: ref.sessionId, trackName: ref.trackName });
      if (!wanted.length) { reply({ type: 'chat_rtc_ready', nonce: msg.nonce, room: p.room, session: 'receive' }); if (watchChanged && p.connected) rtcBroadcast(p.room); return true; }
      const out = await R.subscribe(p.receive, wanted);
      const remoteTracks = allocated(wanted, out.tracks).map(t => ({ ...t, ...(refs.find(x => x.sessionId === t.sessionId && x.trackName === t.trackName) || {}) }));
      p.subscriptions = [...p.subscriptions, ...remoteTracks];
      if (!remoteTracks.length) throw err('realtime_track_rejected', 502);
      if ((watchChanged || remoteTracks.some(t => t.trackName === 'screen')) && p.connected) setImmediate(() => rtcBroadcast(p.room));
      reply({ type: 'chat_rtc_offer', nonce: msg.nonce, room: p.room, session: 'receive', sessionDescription: out.sessionDescription, tracks: remoteTracks });
      return true;
    }
    case 'chat_rtc_answer': {
      const p = rtcBySocket.get(sock);
      const session = msg.session === 'publish' ? p?.publish : msg.session === 'receive' ? p?.receive : null;
      if (!session || !validDescription(msg.sessionDescription)) throw err('not_in_voice', 400);
      await R.renegotiate(session, msg.sessionDescription);
      reply({ type: 'chat_rtc_ready', nonce: msg.nonce, room: p.room, session: msg.session });
      return true;
    }
    case 'chat_rtc_close': {
      const p = rtcBySocket.get(sock), names = Array.isArray(msg.tracks) ? msg.tracks.map(x => clean(x, 40)) : [];
      if (!p || p.room !== String(msg.room || '')) throw err('not_in_voice', 400);
      const closing = p.tracks.filter(t => names.includes(t.trackName));
      if (closing.length) await R.closeTracks(p.publish, closing.map(t => t.mid));
      p.tracks = p.tracks.filter(t => !names.includes(t.trackName));
      if (p.connected) rtcBroadcast(p.room);
      reply({ type: 'chat_rtc_ready', nonce: msg.nonce, room: p.room, session: 'publish' });
      return true;
    }
    case 'chat_rtc_ice': {
      const p = rtcBySocket.get(sock);
      if (!p || p.room !== String(msg.room || '')) throw err('not_in_voice', 400);
      reply({ type: 'chat_rtc_ready', nonce: msg.nonce, room: p.room, session: 'ice', iceServers: await iceServers() });
      return true;
    }
    case 'chat_rtc_leave': leave(sock); return true;
    case 'chat_voice_mute': { // extension: set your muted / deafened flags shown in chat_voice_state
      const p = rtcBySocket.get(sock);
      if (!p || !p.connected) throw err('not_in_voice', 400);
      const v = voiceIn.get(p.room)?.get(p.userId);
      if (v) { v.muted = !!msg.muted; v.deafened = !!msg.deafened; voiceChanged(p.room); }
      return true;
    }
    default: return false;
  }
}

module.exports = { handle, leave, stateOf, configured, setFetch, voiceDenied, rtcRooms, voiceIn };
