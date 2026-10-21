'use strict';
// Instance-local bot accounts + the Discord-dialect bot API (ported from Velora's bonfire-bots.js).
// A bot is a user row of kind 'bot' (principal b:<n>, shown with a BOT tag) plus a `bots` row (hashed token, description, public flag).
// Community managers (MANAGE_SERVER) and instance admins create / manage them; a manager adds a bot to the community.
//   REST     INSTANCE/bot/v1/...      Authorization: Bot <token>      (rate limit 150 requests / 10 s per bot)
//   gateway  INSTANCE/bot/gateway     op 10 hello -> op 2 identify -> READY, GUILD_CREATE, MESSAGE_CREATE / UPDATE / DELETE,
//                                     MESSAGE_REACTION_ADD / REMOVE, GUILD_MEMBER_ADD / REMOVE, GUILD_UPDATE, GUILD_DELETE; op 1 heartbeat
//   token    base64url(<bot n>) + '.' + random, stored as sha256
// Ids are numbers like Discord's: guild = the community row id, channel / message / user = row ids, roles = 1000000000 + role row id,
// @everyone = the guild id.
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const managed = require('./managed');
const C = require('./communities');
const uploads = require('./uploads');
const { P } = require('./perms');
const { err, sha256, now, normalizeOrigin, b64url } = require('./util');
const { presence } = require('./bot-presence');

const M = () => require('./messages');
const ROLE_BASE = 1000000000, MAX_BOTS = 25, NAME = /^[A-Za-z0-9_.-]{2,32}$/, HEARTBEAT = 41250;
const maxBots = () => Math.min(MAX_BOTS, managed.limit('bots') ?? MAX_BOTS);
const origin = () => normalizeOrigin(config.publicUrl());
const apiUrl = () => `${origin()}/bot/v1`;
const gatewayUrl = () => origin().replace(/^http/, 'ws') + '/bot/gateway';

// ---------- accounts ----------
const newToken = userId => `${b64url(String(userId))}.${b64url(crypto.randomBytes(30))}`;
const botRow = id => db.get('SELECT b.*, u.username, u.pfp, u.principal FROM bots b JOIN users u ON u.id = b.user_id WHERE b.user_id = ?', Number(id));
// route params: "b:3" or "3"
const parseId = ref => { const m = /^(?:b:)?(\d{1,15})$/.exec(String(ref || '')); return m ? Number(m[1]) : 0; };
const view = r => ({
  id: r.principal, username: r.username, pfp: r.pfp || null, description: r.description, public: !!r.public,
  servers: db.get('SELECT COUNT(*) AS n FROM members WHERE user_id = ?', r.user_id).n,
  owner: auth.userView(auth.userById(r.owner_id))?.id || null, created_at: r.created_at,
  verified: !!r.gallery_verified, ...(r.gallery_id ? { trusted_in: require('./relay/gallery').trustedIn(r.gallery_id) } : {}), gallery: r.gallery_id ? { id: r.gallery_id, test: !!r.gallery_test } : null, // added from Velora's bot gallery: its profile / token come from Velora
});
const managedByGallery = r => { if (r.gallery_id) throw err('gallery_bot_managed', 403); };
// who may manage bots: instance admins, or anyone with Manage server in the community
function canManage(me) {
  if (auth.isAdmin(me)) return true;
  const c = db.get('SELECT * FROM communities ORDER BY id LIMIT 1');
  return !!c && C.snapOf(c).can(me.id, P.MANAGE_SERVER);
}
function guard(me) { if (!canManage(me)) throw err('not_allowed', 403); }
function own(me, ref) {
  guard(me);
  const r = botRow(parseId(ref));
  if (!r) throw err('bot_not_found', 404);
  return r;
}
// the manage page lists only bots created on this server; gallery bots (gallery_id set) are managed from Velora, never here
const mine = me => { guard(me); return { bots: db.all('SELECT user_id FROM bots WHERE gallery_id IS NULL ORDER BY user_id').map(r => view(botRow(r.user_id))), max: maxBots(), used: managed.botCount() }; };
function checkName(name, exceptId = 0) {
  if (!NAME.test(name)) throw err('bad_bot_name');
  if (db.get('SELECT 1 FROM users WHERE LOWER(username) = ? AND id <> ?', name.toLowerCase(), exceptId)) throw err('name_taken');
}
function create(me, { name, description } = {}) {
  guard(me);
  name = String(name || '').trim();
  checkName(name);
  const have = managed.botCount();
  managed.assertRoom('bots', have);
  if (db.get('SELECT COUNT(*) AS n FROM bots').n >= MAX_BOTS) throw err('too_many_bots');
  const id = db.tx(() => {
    const r = db.run("INSERT INTO users (principal, kind, username, display_name, username_lc, created_at) VALUES ('pending', 'bot', ?, ?, ?, ?)", name, name, name.toLowerCase(), now());
    db.run('UPDATE users SET principal = ? WHERE id = ?', 'b:' + r.lastInsertRowid, r.lastInsertRowid);
    return Number(r.lastInsertRowid);
  });
  const token = newToken(id);
  db.run('INSERT INTO bots (user_id, owner_id, token_hash, description, created_at) VALUES (?, ?, ?, ?, ?)', id, me.id, sha256(token), String(description || '').slice(0, 300), now());
  return { bot: view(botRow(id)), token };
}
function update(me, ref, body = {}) {
  const r = own(me, ref);
  managedByGallery(r);
  if (body.description !== undefined) db.run('UPDATE bots SET description = ? WHERE user_id = ?', String(body.description || '').slice(0, 300), r.user_id);
  if (body.public !== undefined) db.run('UPDATE bots SET public = ? WHERE user_id = ?', body.public ? 1 : 0, r.user_id);
  if (body.name !== undefined) {
    const name = String(body.name || '').trim();
    checkName(name, r.user_id);
    db.run('UPDATE users SET username = ?, display_name = ?, username_lc = ? WHERE id = ?', name, name, name.toLowerCase(), r.user_id);
    auth.identityChanged(auth.userById(r.user_id), r.username);
  }
  return { bot: view(botRow(r.user_id)) };
}
function setAvatar(me, ref, buffer) {
  const r = own(me, ref);
  managedByGallery(r);
  if (!buffer) throw err('no_file');
  db.run('UPDATE users SET pfp = ? WHERE id = ?', uploads.saveImage(buffer, 'bot'), r.user_id);
  auth.identityChanged(auth.userById(r.user_id), r.username);
  return { bot: view(botRow(r.user_id)) };
}
function resetToken(me, ref) {
  const r = own(me, ref);
  managedByGallery(r);
  const token = newToken(r.user_id);
  db.run('UPDATE bots SET token_hash = ? WHERE user_id = ?', sha256(token), r.user_id);
  closeGateways(r.user_id, 4004, 'token reset');
  return { token };
}
function remove(me, ref) {
  const r = own(me, ref);
  managedByGallery(r); // remove it from the server with Kick / Ban under Members; the gallery install itself belongs to Velora
  for (const m of db.all('SELECT community_id FROM members WHERE user_id = ?', r.user_id)) C.removeMember(db.get('SELECT * FROM communities WHERE id = ?', m.community_id), r.user_id, 'left');
  closeGateways(r.user_id, 4004, 'deleted');
  db.run('DELETE FROM users WHERE id = ? AND kind = ?', r.user_id, 'bot');
}
// a bot's profile + the communities you could add it to
function info(me, username) {
  const u = db.get("SELECT id FROM users WHERE kind = 'bot' AND LOWER(username) = ?", String(username || '').toLowerCase());
  const r = u && botRow(u.id);
  if (!r) throw err('bot_not_found', 404);
  const c = db.get('SELECT * FROM communities ORDER BY id LIMIT 1');
  const snap = c && C.snapOf(c);
  const mayAdd = !!snap && snap.can(me.id, P.MANAGE_SERVER) && (r.public || Number(r.owner_id) === me.id || auth.isAdmin(me)) && !snap.isMember(r.user_id);
  return { bot: { id: r.principal, username: r.username, description: r.description, public: !!r.public, verified: !!r.gallery_verified, gallery_id: r.gallery_id ? String(r.gallery_id) : null, ...(r.gallery_id ? { trusted_in: require('./relay/gallery').trustedIn(r.gallery_id) } : {}), owner: auth.userById(r.owner_id)?.username || null, mine: Number(r.owner_id) === me.id }, can_add_to: mayAdd ? [{ sid: c.sid, name: c.name, icon: c.icon_url || null }] : [] };
}
function addToServer(me, username, sid) {
  const u = db.get("SELECT id FROM users WHERE kind = 'bot' AND LOWER(username) = ?", String(username || '').toLowerCase());
  const r = u && botRow(u.id);
  if (!r) throw err('bot_not_found', 404);
  const { c, snap } = C.memberCommunity(sid, me);
  if (!snap.can(me.id, P.MANAGE_SERVER)) throw err('not_allowed', 403);
  if (!r.public && Number(r.owner_id) !== me.id && !auth.isAdmin(me)) throw err('bot_is_private', 403);
  if (db.get('SELECT 1 FROM bans WHERE community_id = ? AND user_id = ?', c.id, r.user_id)) throw err('banned_from_server', 403);
  if (snap.isMember(r.user_id)) throw err('already_in_server');
  if (r.gallery_id) throw err('gallery_bot_managed', 403); // re-add requires a fresh Velora ticket
  C.addMember(c, r.user_id);
}

// ---------- API auth ----------
// "Bot <token>" -> the bot's user row | null
function fromHeader(h) {
  const m = /^Bot\s+(\S+)$/i.exec(String(h || ''));
  if (!m || m[1].length > 200) return null;
  const r = db.get('SELECT user_id, gallery_active FROM bots WHERE token_hash = ?', sha256(m[1]));
  if (r && r.gallery_active === 0) return null; // a gallery bot Velora took away
  const u = r && auth.userById(r.user_id);
  return u && !u.banned ? u : null;
}

// ---------- Discord-shaped objects ----------
const uidOf = (() => { return principal => db.get('SELECT id FROM users WHERE principal = ?', String(principal))?.id; })();
const userObj = u => ({ id: String(u.id), username: u.username, global_name: u.display_name || u.username, discriminator: '0', avatar: u.pfp ? 'bonfire' : null, avatar_url: u.pfp || null, bot: u.kind === 'bot', ...(db.get('SELECT 1 FROM bots WHERE user_id = ? AND gallery_verified = 1', Number(u.id)) ? { verified: true } : {}) });
function permsToDiscord(p) {
  let d = 1024n | 65536n | 16384n | 64n; // view, read history, embed links, add reactions
  if (p & P.ADMIN) d |= 8n;
  const map = [[P.SEND, 2048n], [P.MANAGE_CHANNELS, 16n], [P.MANAGE_SERVER, 32n], [P.MANAGE_ROLES, 1n << 28n], [P.KICK, 2n], [P.BAN, 4n], [P.MANAGE_MESSAGES, 8192n], [P.MENTION_EVERYONE, 131072n], [P.ATTACH, 32768n]];
  for (const [b, x] of map) if (p & b) d |= x;
  return String(d);
}
const roleId = (c, r) => (r.is_default ? String(c.id) : String(ROLE_BASE + r.id));
const roleObj = (c, r) => ({ id: roleId(c, r), name: r.name, color: r.color ? parseInt(r.color.slice(1), 16) : 0, position: r.position, permissions: permsToDiscord(Number(r.permissions)), hoist: !!r.hoist, mentionable: !!r.mentionable, managed: false });
const channelObj = (ch, c) => ({ id: String(ch.id), type: ch.type === 'voice' ? 2 : 0, guild_id: String(c.id), name: ch.name, topic: ch.topic || null, position: ch.position, parent_id: null, nsfw: false, permission_overwrites: [], bonfire_type: ch.type || 'text', last_message_id: ch.last_message_id ? String(ch.last_message_id) : null });
const guildObj = (c, snap, full, bot) => {
  const out = { id: String(c.id), name: c.name, icon: c.icon_url ? 'bonfire' : null, icon_url: c.icon_url || null, owner_id: String(c.owner_id), description: c.description || null, member_count: C.memberCount(c.id), roles: snap.roles.map(r => roleObj(c, r)) };
  if (full) out.channels = snap.channels.filter(ch => !bot || snap.canView(ch, bot.id)).map(ch => channelObj(ch, c));
  return out;
};
const mimeOf = a => (a.type === 'gif' ? 'image/gif' : a.type === 'image' ? (/\.webp(\?|$)/i.test(a.url) ? 'image/webp' : /\.jpe?g(\?|$)/i.test(a.url) ? 'image/jpeg' : 'image/png') : a.type === 'video' ? 'video/mp4' : a.type === 'audio' ? 'audio/mpeg' : 'application/octet-stream');
const nameCache = new Map(); // community id -> { at, map(lowercase username -> user id) }
function memberNames(communityId) {
  const hit = nameCache.get(communityId);
  if (hit && Date.now() - hit.at < 30000) return hit.map;
  const map = new Map(db.all('SELECT u.id, u.username FROM members m JOIN users u ON u.id = m.user_id WHERE m.community_id = ?', communityId).map(r => [String(r.username).toLowerCase(), r.id]));
  nameCache.set(communityId, { at: Date.now(), map });
  return map;
}
// a Bonfire message view -> a Discord message object
function messageObj(m, c, snap) {
  const ch = snap.channels.find(x => x.cid === m.channel);
  const names = memberNames(c.id), mentions = [];
  const content = String(m.body || '')
    .replace(/(^|[^\w])@([\w.-]{2,32})/g, (all, pre, name) => {
      const id = names.get(name.toLowerCase());
      if (!id) return all;
      if (!mentions.some(x => x.id === String(id))) mentions.push({ id: String(id), username: name, global_name: name, bot: db.get('SELECT kind FROM users WHERE id = ?', id)?.kind === 'bot' });
      return `${pre}<@${id}>`;
    })
    .replace(/<@&(r[0-9a-f]{10})>/g, (all, rid) => { const r = snap.roles.find(x => x.rid === rid); return r ? `<@&${ROLE_BASE + r.id}>` : all; });
  const au = m.author, auId = au?.id ? uidOf(au.id) : null;
  const author = au ? (auId ? userObj({ ...au, id: auId }) : { id: '0', username: au.username, global_name: au.username, discriminator: '0', avatar: null, avatar_url: au.pfp || null, bot: !!au.webhook })
    : { id: '0', username: 'Bonfire', bot: true };
  const out = {
    id: String(m.id), channel_id: String(ch?.id), guild_id: String(c.id), type: m.system ? 6 : m.reply ? 19 : 0, content, author, mentions,
    mention_roles: (m.mention_roles || []).map(rid => { const r = snap.roles.find(x => x.rid === rid); return r ? String(ROLE_BASE + r.id) : null; }).filter(Boolean),
    mention_everyone: !!m.mention_everyone,
    attachments: (m.attachments || []).map((a, i) => ({ id: String(i), filename: a.name || String(a.url).split('?')[0].split('/').pop(), url: a.url, proxy_url: a.url, size: a.size || 0, content_type: mimeOf(a), width: a.width, height: a.height })),
    embeds: m.embeds || [], pinned: !!m.pinned, tts: false,
    reactions: (m.reactions || []).map(x => { const cm = /^<a?:(\w+):(e[0-9a-f]{10})>$/.exec(x.emoji); return { emoji: cm ? { id: cm[2], name: cm[1] } : { id: null, name: x.emoji }, count: x.count, me: false }; }),
    timestamp: new Date(m.created_at).toISOString(), edited_timestamp: m.edited_at ? new Date(m.edited_at).toISOString() : null,
    member: auId ? { roles: [...snap.roleIds(auId)].map(id => String(ROLE_BASE + id)), nick: null } : undefined,
    channel_name: ch?.name, guild_name: c.name, bonfire: { cid: m.channel, sid: c.sid, bridge: au?.bridge || undefined },
  };
  if (au?.webhook && !au.bridge) out.webhook_id = '1';
  if (m.reply) {
    out.message_reference = { message_id: String(m.reply.id), channel_id: String(ch?.id), guild_id: String(c.id) };
    const ra = m.reply.author, raId = ra?.id ? uidOf(ra.id) : null;
    out.referenced_message = { id: String(m.reply.id), channel_id: String(ch?.id), content: m.reply.body || '', author: ra ? { id: String(raId || 0), username: ra.username, avatar_url: ra.pfp || null, bot: raId ? db.get('SELECT kind FROM users WHERE id = ?', raId)?.kind === 'bot' : true } : null };
    if (raId) out.message_reference.author_id = String(raId);
  }
  return out;
}
// Discord-style text from a bot -> Bonfire text
function textIn(c, snap, text, allowed) {
  let t = String(text ?? '').slice(0, M().MSG_MAX);
  const ids = [...new Set([...t.matchAll(/<@!?(\d+)>/g)].map(x => Number(x[1])))].slice(0, 50);
  const names = new Map(ids.length ? db.all(`SELECT u.id, u.username FROM users u JOIN members m ON m.user_id = u.id WHERE m.community_id = ? AND u.id IN (${db.inList(ids)})`, c.id, ...ids).map(r => [r.id, r.username]) : []);
  const pingUsers = !allowed || !Array.isArray(allowed.parse) || allowed.parse.includes('users');
  const okIds = new Set((allowed?.users || []).map(String));
  t = t.replace(/<@!?(\d+)>/g, (all, id) => { const n = names.get(Number(id)); return !n ? '@someone' : pingUsers || okIds.has(id) ? `@${n}` : `@​${n}`; });
  t = t.replace(/<@&(\d+)>/g, (all, id) => { const r = snap.roles.find(x => ROLE_BASE + x.id === Number(id)); return r ? `<@&${r.rid}>` : '@role'; });
  t = t.replace(/<#(\d+)>/g, (all, id) => { const ch = snap.channels.find(x => x.id === Number(id)); return ch ? `#${ch.name}` : '#channel'; });
  if (allowed && Array.isArray(allowed.parse) && !allowed.parse.includes('everyone')) t = t.replace(/@(everyone|here)\b/g, '@​$1');
  return t;
}

// ---------- gateway (/bot/gateway) ----------
const gateways = new Set(); // { ws, botId, seq, last }
let wss = null, presenceSweep = null;
const gwSend = (g, t, d) => { if (g.ws.readyState !== 1) return; g.seq++; g.ws.send(JSON.stringify({ op: 0, t, s: g.seq, d })); };
function closeGateways(botId, code, reason) { for (const g of gateways) if (g.botId === Number(botId)) { g.dispose(); g.ws.close(code, reason); } }
function memberRemoved(botId, communityId, reason) {
  for (const g of gateways) if (g.botId === Number(botId)) gwSend(g, 'GUILD_DELETE', { id: String(communityId), unavailable: false });
  if (!db.get('SELECT 1 FROM members WHERE user_id = ?', Number(botId))) closeGateways(botId, 4003, 'community membership removed: ' + reason);
}
function guildsOf(userId) {
  return db.all('SELECT c.* FROM communities c JOIN members m ON m.community_id = c.id WHERE m.user_id = ? ORDER BY c.id', userId);
}
function onConnection(ws) {
  const g = { ws, botId: null, seq: 0, last: Date.now() };
  gateways.add(g);
  ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: HEARTBEAT } }));
  if (!presenceSweep) { presenceSweep = setInterval(() => presence.sweep(), 15000); presenceSweep.unref(); }
  const noIdentify = setTimeout(() => { if (!g.botId) { g.dispose(); ws.close(4003, 'not authenticated'); } }, 20000);
  g.dispose = () => {
    clearTimeout(noIdentify); presence.remove(g); gateways.delete(g);
    if (!gateways.size) { clearInterval(presenceSweep); presenceSweep = null; }
  };
  ws.on('message', raw => {
    let ev; try { ev = JSON.parse(raw); } catch { return; }
    if (!ev || typeof ev !== 'object') return;
    if (!gateways.has(g) || ws.readyState !== 1) return;
    if (ev.op === 1) { g.last = Date.now(); ws.send(JSON.stringify({ op: 11 })); return; }
    if (ev.op === 2 || ev.op === 6) {
      if (g.botId) { g.dispose(); ws.close(4005, 'already authenticated'); return; }
      const u = fromHeader(`Bot ${String(ev.d?.token || '').replace(/^Bot\s+/i, '')}`);
      if (!u) { ws.close(4004, 'authentication failed'); return; }
      g.botId = u.id; g.last = Date.now();
      clearTimeout(noIdentify);
      const list = guildsOf(u.id);
      gwSend(g, 'READY', { v: 1, user: userObj(u), guilds: list.map(c => ({ id: String(c.id), unavailable: true })), session_id: crypto.randomBytes(8).toString('hex'), resume_gateway_url: gatewayUrl(), application: { id: String(u.id) } });
      presence.add(g);
      for (const c of list) gwSend(g, 'GUILD_CREATE', guildObj(c, C.snapOf(c), true, u));
    }
  });
  ws.on('close', g.dispose);
  ws.on('error', () => { g.dispose(); ws.terminate(); });
}
function handleUpgrade(req, socket, head) {
  if (!wss) { wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 }); wss.on('connection', onConnection); }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
}
function shutdown() { for (const g of gateways) { g.dispose(); try { g.ws.close(1001, 'shutdown'); g.ws.terminate(); } catch { /* gone */ } } presence.clear(); wss?.close(); wss = null; }

// gateway.emit hands us every community event; bots that are members get it in Discord's shape
function dispatch(communityId, obj) {
  if (!gateways.size || !obj) return;
  const here = [...gateways].filter(g => g.botId && db.get('SELECT 1 FROM members WHERE community_id = ? AND user_id = ?', communityId, g.botId));
  if (!here.length && !(obj.type === 'chat_member_update' && String(obj.user_id).startsWith('b:'))) return;
  const c = db.get('SELECT * FROM communities WHERE id = ?', communityId);
  if (!c) return;
  const snap = C.snapOf(c);
  const chOf = cid => snap.channels.find(x => x.cid === cid);
  const sees = (g, ch) => !ch || snap.canView(ch, g.botId);
  let t, d, only = null, ch = null;
  const principalId = p => uidOf(p) ?? 0;
  if (obj.type === 'chat_message' || obj.type === 'chat_message_update') {
    ch = chOf(obj.message?.channel);
    if (!ch) return;
    t = obj.type === 'chat_message' ? 'MESSAGE_CREATE' : 'MESSAGE_UPDATE'; d = messageObj(obj.message, c, snap);
  } else if (obj.type === 'chat_message_delete') {
    ch = chOf(obj.channel);
    if (!ch) return;
    t = 'MESSAGE_DELETE'; d = { id: String(obj.id), channel_id: String(ch.id), guild_id: String(c.id) };
  } else if (obj.type === 'chat_reactions') {
    ch = chOf(obj.channel);
    if (!ch) return;
    const cm = /^<a?:(\w+):(e[0-9a-f]{10})>$/.exec(obj.emoji);
    t = obj.add ? 'MESSAGE_REACTION_ADD' : 'MESSAGE_REACTION_REMOVE';
    d = { user_id: String(principalId(obj.user_id)), channel_id: String(ch.id), message_id: String(obj.id), guild_id: String(c.id), emoji: cm ? { id: cm[2], name: cm[1] } : { id: null, name: obj.emoji } };
  } else if (obj.type === 'chat_member_update' && ['joined', 'left', 'kicked', 'banned'].includes(obj.change)) {
    const uid = principalId(obj.user_id);
    nameCache.delete(c.id);
    if (obj.change === 'joined') {
      here.filter(g => g.botId === uid).forEach(g => gwSend(g, 'GUILD_CREATE', guildObj(c, snap, true, auth.userById(uid)))); // the bot itself was added: it gets everything
      only = g => g.botId !== uid;
      t = 'GUILD_MEMBER_ADD'; d = { guild_id: String(c.id), user: { id: String(uid), username: obj.username, bot: String(obj.user_id).startsWith('b:'), avatar_url: obj.member?.pfp || null }, roles: [], joined_at: new Date().toISOString() };
    } else {
      only = g => g.botId !== uid;
      t = 'GUILD_MEMBER_REMOVE'; d = { guild_id: String(c.id), user: { id: String(uid), username: obj.username } };
    }
  } else if (obj.type === 'chat_channels_update') {
    here.forEach(g => gwSend(g, 'GUILD_UPDATE', guildObj(c, snap, true, auth.userById(g.botId))));
    return;
  } else return;
  here.filter(g => sees(g, ch) && (!only || only(g))).forEach(g => gwSend(g, t, d));
}

module.exports = {
  mine, create, update, setAvatar, resetToken, remove, info, addToServer, fromHeader, parseId, viewOf: id => view(botRow(id)), closeGatewaysOf: closeGateways,
  userObj, guildObj, channelObj, roleObj, messageObj, textIn, handleUpgrade, shutdown, dispatch, uidOf,
  ROLE_BASE, MAX_BOTS, apiUrl, gatewayUrl, memberRemoved,
};
