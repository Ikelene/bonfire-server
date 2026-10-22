'use strict';
// Discord / Fluxer <-> this instance's community (ported from Velora's bridge.js; PROTOCOL §16).
//   Discord/Fluxer -> here: the owner's bot reads its gateway; messages from linked channels are posted with
//                           messages.postBridged as the person (name + picture), tagged with the platform
//   here -> Discord/Fluxer: a webhook ("Ember bridge") in each linked channel posts as the Ember person
// Loop prevention: posts through our own webhooks and ids we just sent are never taken back in, and a bridged message is
// never sent back to the platform it came from. Edits and deletes are mirrored through the bridge_msgs id map.
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const C = require('../communities');
const uploads = require('../uploads');
const store = require('./store');
const PL = require('./platform');
const { P } = require('../perms');
const { err, now, clean, normalizeOrigin, log } = require('../util');

const M = () => require('../messages');
const W = () => require('../webhooks');
const ZW = '\u200b';
const RETENTION = 60 * 24 * 3600 * 1000; // id map rows live 60 days
const TEXTISH = [0, 5]; // text, announcement
const origin = () => normalizeOrigin(config.publicUrl());

// ---------------------------------------------------------------- gateway clients (one per configured platform)
const clients = new Map(); // platform -> GatewayClient
const selfUser = new Map(); // platform -> { at, user }
function startClient(p) {
  stopClient(p);
  const tok = PL.tokenOf(p);
  if (!tok) return;
  const c = new PL.GatewayClient(p, tok, onEvent);
  clients.set(p, c);
  c.start();
}
function stopClient(p) { const c = clients.get(p); if (c) c.stop(); clients.delete(p); selfUser.delete(p); }
async function botUser(p) {
  const hit = selfUser.get(p);
  if (hit && Date.now() - hit.at < 3600e3) return hit.user;
  const user = await PL.rest(p, 'GET', '/users/@me');
  selfUser.set(p, { at: Date.now(), user });
  return user;
}
const configured = p => !!PL.tokenOf(p);
function needPlatform(p) {
  if (!PL.IDS.includes(p)) throw err('bad_platform', 404);
  if (!configured(p)) throw err('bridge_not_set_up', 503);
  return PL.platform(p);
}

// ---------------------------------------------------------------- instance settings (admins): the bot tokens, write-only
const mask = t => (t ? `${'*'.repeat(8)}${String(t).slice(-4)}` : null);
function settingsView() {
  const out = {};
  for (const p of PL.IDS) {
    const c = clients.get(p);
    out[p] = {
      configured: configured(p), token: mask(PL.tokenOf(p)), source: PL.tokenSource(p),
      state: c ? c.state : 'off', error: c?.error || null,
      bot: c?.user ? { id: String(c.user.id), username: c.user.username } : selfUser.get(p)?.user ? { id: String(selfUser.get(p).user.id), username: selfUser.get(p).user.username } : null,
    };
  }
  return out;
}
// patch: { discord: { token: "<new>" | null (remove) | "" (keep) }, fluxer: { ... } }. A new token is checked first (GET /users/@me).
async function saveSettings(patch = {}) {
  for (const p of PL.IDS) {
    const v = patch?.[p];
    if (!v || typeof v !== 'object' || !('token' in v)) continue;
    if (v.token === null) { store.setSetting(`${p}.token`, null); stopClient(p); if (PL.tokenOf(p)) startClient(p); continue; }
    if (typeof v.token !== 'string') throw err('invalid_token', 400, { platform: p });
    const tok = v.token.trim().replace(/^Bot\s+/i, '');
    if (!tok) continue; // empty = keep
    if (tok.length > 200 || /\s/.test(tok)) throw err('invalid_token', 400, { platform: p });
    let user;
    try { user = await PL.rest(p, 'GET', '/users/@me', null, { token: tok }); } catch (e) {
      if (e.status === 401 || e.status === 403) throw err('invalid_token', 400, { platform: p });
      throw err('platform_unreachable', 502, { platform: p });
    }
    store.setSetting(`${p}.token`, tok);
    startClient(p);
    selfUser.set(p, { at: Date.now(), user });
  }
  return settingsView();
}

// ---------------------------------------------------------------- links (bridge_guilds + bridge_channels)
const LINK_SQL = `SELECT bc.*, bg.platform, bg.guild_id, bg.community_id, bg.enabled FROM bridge_channels bc JOIN bridge_guilds bg ON bg.id = bc.bridge_id`;
const linkByExt = (p, extCh) => { store.ensure(); return db.get(`${LINK_SQL} WHERE bg.platform = ? AND bc.ext_channel_id = ?`, p, String(extCh)); };
const linksOfChannel = channelId => { store.ensure(); return db.all(`${LINK_SQL} WHERE bc.channel_id = ?`, Number(channelId)); };
const isOurHook = hookId => { store.ensure(); return !!db.get('SELECT 1 FROM bridge_channels WHERE hook_id = ?', String(hookId)); };
// channel view tag: [{ platform, name }] for the channel header (communities.channelView)
function channelTag(channelId) {
  try { return linksOfChannel(channelId).filter(l => l.enabled).map(l => ({ platform: l.platform, name: l.ext_name })); } catch { return []; }
}

// small per-guild caches (roles / channels / emojis change rarely)
const guildCache = new Map();
async function guildThing(p, gid, what, fresh = false) {
  const k = `${p}:${gid}:${what}`;
  const hit = guildCache.get(k);
  if (!fresh && hit && Date.now() - hit.at < 10 * 60e3) return hit.v;
  const v = await PL.rest(p, 'GET', `/guilds/${gid}${what ? `/${what}` : ''}`);
  guildCache.set(k, { at: Date.now(), v });
  if (guildCache.size > 500) guildCache.delete(guildCache.keys().next().value);
  return v;
}

// ---------------------------------------------------------------- files: avatars + attachments are re-hosted here
async function download(url, max) {
  const r = await fetch(url, { headers: { 'User-Agent': PL.UA }, redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`download ${r.status}`);
  const len = Number(r.headers.get('content-length') || 0);
  if (len && len > max) throw err('too_big');
  const chunks = []; let n = 0;
  for await (const c of r.body) { n += c.length; if (n > max) throw err('too_big'); chunks.push(Buffer.from(c)); }
  return Buffer.concat(chunks);
}
async function hostAvatar(p, user) {
  if (!user?.id || !user.avatar) return null;
  const key = `${p}_${String(user.id).replace(/\D/g, '')}_${String(user.avatar).replace(/[^a-z0-9_]/gi, '').slice(0, 40)}.png`;
  const rel = `bridge/avatars/${key}`;
  if (!fs.existsSync(path.join(uploads.root(), rel))) {
    try {
      const buf = await download(`${PL.platform(p).cdn}/avatars/${user.id}/${user.avatar}.png?size=128`, 4 << 20);
      const sn = uploads.sniff(buf);
      if (!sn || !['image', 'gif'].includes(sn.type)) return null;
      uploads.writeStored(rel, buf);
    } catch { return null; }
  }
  return `${origin()}/uploads/${rel}`;
}
// an attachment over there -> an upload here (capped by the community's / instance's upload limit, 25 MB at most)
async function hostFile(p, a, maxBytes) {
  const url = String(a.url || a.proxy_url || '');
  if (!PL.platform(p).media.test(url) || (Number(a.size) || 0) > maxBytes) return null;
  try {
    const buf = await download(url, maxBytes);
    const up = uploads.storeUpload(buf, String(a.filename || 'file').replace(/[^\w.-]+/g, '_').slice(-80) || 'file', null);
    return { url: up.url, type: up.type, name: up.name, size: up.size, width: up.width || a.width || undefined, height: up.height || a.height || undefined };
  } catch { return null; }
}

// ---------------------------------------------------------------- text both ways
const emojisOf = communityId => db.all('SELECT eid, name, animated FROM emojis WHERE community_id = ?', communityId);
// Discord / Fluxer text -> Ember text. Mentions become plain names (with a zero-width space after @), so nothing pings here.
async function textIn(link, d) {
  let t = String(d.content || '');
  const p = link.platform;
  const names = new Map((d.mentions || []).map(u => [String(u.id), u.member?.nick || u.global_name || u.username]));
  t = t.replace(/<@!?(\d+)>/g, (_, id) => `@${ZW}${names.get(id) || 'someone'}`);
  if (/<@&\d+>/.test(t)) {
    const roles = await guildThing(p, link.guild_id, 'roles').catch(() => []);
    t = t.replace(/<@&(\d+)>/g, (_, id) => `@${ZW}${(Array.isArray(roles) ? roles : []).find(r => String(r.id) === id)?.name || 'role'}`);
  }
  if (/<#\d+>/.test(t)) {
    const chans = await guildThing(p, link.guild_id, 'channels').catch(() => []);
    t = t.replace(/<#(\d+)>/g, (_, id) => {
      const here = linkByExt(p, id);
      const ch = here && db.get('SELECT name FROM channels WHERE id = ?', here.channel_id);
      return `#${ch ? ch.name : ((Array.isArray(chans) ? chans : []).find(x => String(x.id) === id)?.name || 'channel')}`;
    });
  }
  if (/<a?:\w+:\d+>/.test(t)) {
    const mine = emojisOf(link.community_id);
    t = t.replace(/<(a?):(\w+):(\d+)>/g, (_, a, n) => {
      const e = mine.find(x => x.name.toLowerCase() === n.toLowerCase());
      return e ? `<${e.animated ? 'a' : ''}:${e.name}:${e.eid}>` : `:${n}:`;
    });
  }
  // nothing that pings: @everyone / @here, and Ember's own role / user tokens typed over there
  return t.replace(/@(everyone|here)\b/g, `@${ZW}$1`).replace(/<@&/g, `<${ZW}@&`);
}
// Ember text -> Discord / Fluxer text (role tokens as names, custom emojis matched by name)
async function textOut(link, body, communityId) {
  let t = String(body || '');
  const roles = db.all('SELECT rid, name FROM roles WHERE community_id = ?', communityId);
  t = t.replace(/<@&(r[0-9a-f]{10})>/g, (_, rid) => `@${roles.find(r => r.rid === rid)?.name || 'role'}`);
  if (/<a?:\w+:e[0-9a-f]{10}>/.test(t)) {
    const theirs = await guildThing(link.platform, link.guild_id, 'emojis').catch(() => []);
    t = t.replace(/<(a?):(\w+):(e[0-9a-f]{10})>/g, (_, a, n) => {
      const e = (Array.isArray(theirs) ? theirs : []).find(x => String(x.name).toLowerCase() === n.toLowerCase());
      return e ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : `:${n}:`;
    });
  }
  return t;
}
const snippet = (s, n = 90) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}...` : s; };

// ---------------------------------------------------------------- Discord / Fluxer -> here
const queues = new Map(); // key -> promise chain (keeps each channel's order)
function enqueue(key, fn) {
  const next = (queues.get(key) || Promise.resolve()).then(fn, fn).catch(e => console.error('[bridge]', e.message));
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
  return next;
}
const recentOut = new Set(); // ext message ids we just sent through a webhook
function rememberOut(id) { recentOut.add(String(id)); setTimeout(() => recentOut.delete(String(id)), 120e3).unref?.(); }

function onEvent(p, t, d) {
  if (!PL.IDS.includes(p) || !d) return;
  const key = `in:${p}:${d.channel_id}`;
  if (t === 'MESSAGE_CREATE') return enqueue(key, () => inbound(p, d));
  if (t === 'MESSAGE_UPDATE') {
    return enqueue(key, async () => {
      if (d.content === undefined) return;
      const link = linkByExt(p, d.channel_id);
      const m = db.get('SELECT message_id FROM bridge_msgs WHERE ext_message_id = ? AND platform = ? AND outbound = 0', String(d.id), p);
      if (link && m) M().editBridged(m.message_id, await textIn(link, d));
    });
  }
  if (t === 'MESSAGE_DELETE' || t === 'MESSAGE_DELETE_BULK') {
    return enqueue(key, async () => {
      const ids = (t === 'MESSAGE_DELETE' ? [d.id] : d.ids || []).map(String).slice(0, 200);
      for (const id of ids) {
        const m = db.get('SELECT message_id FROM bridge_msgs WHERE ext_message_id = ? AND platform = ? AND outbound = 0', id, p);
        if (m) { db.run('DELETE FROM bridge_msgs WHERE message_id = ? AND platform = ?', m.message_id, p); M().deleteBridged(m.message_id); }
      }
    });
  }
}
async function inbound(p, d) {
  const link = linkByExt(p, d.channel_id);
  if (!link || !link.enabled) return;
  if (d.webhook_id && isOurHook(d.webhook_id)) return; // our own posts from here
  if (recentOut.has(String(d.id))) return;
  if (![0, 19, 20].includes(Number(d.type ?? 0))) return; // normal messages, replies, slash command replies
  const ch = db.get('SELECT * FROM channels WHERE id = ?', link.channel_id);
  const c = ch && db.get('SELECT * FROM communities WHERE id = ?', ch.community_id);
  if (!c) return;
  const a = d.author || {};
  const name = (d.webhook_id ? a.username : d.member?.nick || a.global_name || a.username) || 'someone';
  const avatar = await hostAvatar(p, a);
  let body = await textIn(link, d);
  const maxBytes = Math.min(25, c.upload_max_mb || 25, config.get().max_upload_mb || 25) * 1024 * 1024;
  const atts = [], extra = [];
  for (const x of (d.attachments || []).slice(0, 8)) {
    const h = atts.length < 4 && c.allow_uploads ? await hostFile(p, x, maxBytes) : null;
    if (h) atts.push(h); else if (x.url) extra.push(String(x.url));
  }
  for (const s of (d.sticker_items || d.stickers || []).slice(0, 2)) {
    const h = atts.length < 4 && c.allow_uploads ? await hostFile(p, { url: `${PL.platform(p).cdn}/stickers/${s.id}.png`, filename: `${s.name || 'sticker'}.png` }, maxBytes) : null;
    if (h) atts.push(h);
  }
  if (extra.length) body = [body, ...extra].filter(Boolean).join('\n');
  // replies: to a bridged message = a real reply; otherwise quote what they answered
  let replyTo = null;
  const ref = d.message_reference?.message_id;
  if (ref) {
    const m = db.get('SELECT message_id FROM bridge_msgs WHERE ext_message_id = ? AND platform = ?', String(ref), p);
    if (m) replyTo = m.message_id;
    else if (d.referenced_message) {
      const r = d.referenced_message;
      body = `> **${r.member?.nick || r.author?.global_name || r.author?.username || 'someone'}** ${snippet(await textIn(link, r) || '(a picture)')}\n${body}`;
    }
  }
  const embeds = W().cleanEmbeds((d.embeds || []).filter(e => e && (e.type === 'rich' || !e.type)).slice(0, 5));
  if (!body.trim() && !atts.length && !embeds.length) return;
  const msg = M().postBridged(ch, { platform: p, name: String(name).slice(0, 80), avatar, body, attachments: atts, embeds: embeds.length ? embeds : undefined, replyTo });
  db.run('INSERT OR IGNORE INTO bridge_msgs (message_id, platform, ext_message_id, ext_channel_id, outbound, created_at) VALUES (?, ?, ?, ?, 0, ?)', Number(msg.id), p, String(d.id), String(d.channel_id), now());
}

// ---------------------------------------------------------------- here -> Discord / Fluxer (a webhook per linked channel)
// webhook names can't contain "discord" or "clyde"
const hookName = s => String(s || '').replace(/discord|clyde/gi, '').trim().slice(0, 80) || 'Ember';
const absUrl = u => (!u ? undefined : /^https?:/i.test(u) ? u : `${origin()}${u.startsWith('/') ? '' : '/'}${u}`);
async function ensureHook(link) {
  if (link.hook_id && link.hook_token) return link;
  const h = await PL.rest(link.platform, 'POST', `/channels/${link.ext_channel_id}/webhooks`, { name: 'Ember bridge' });
  db.run('UPDATE bridge_channels SET hook_id = ?, hook_token = ? WHERE channel_id = ? AND bridge_id = ?', String(h.id), String(h.token), link.channel_id, link.bridge_id);
  link.hook_id = String(h.id); link.hook_token = String(h.token);
  return link;
}
async function execHook(link, payload) {
  return PL.rest(link.platform, 'POST', `/webhooks/${link.hook_id}/${link.hook_token}?wait=true`, payload, { auth: false });
}
// messages.onPost: everything posted here goes to the linked channels, except system lines, instance webhooks and
// (for a bridged message) the platform it came from
function onPost(msg, ctx, meta) {
  if (meta.system || meta.webhook) return;
  const links = linksOfChannel(ctx.ch.id);
  if (!links.length) return;
  for (const link of links) {
    if (!link.enabled || link.platform === meta.bridged || !configured(link.platform)) continue;
    enqueue(`out:${ctx.ch.id}:${link.platform}`, () => outbound(link, ctx, msg));
  }
}
async function outbound(link, ctx, msg) {
  await ensureHook(link);
  let text = await textOut(link, msg.body, ctx.c.id);
  if (msg.reply) {
    const m = db.get('SELECT ext_message_id FROM bridge_msgs WHERE message_id = ? AND platform = ?', Number(msg.reply.id), link.platform);
    const who = msg.reply.author?.username || 'Ember';
    text = `> **${who}** ${snippet(msg.reply.body || '(a picture)')}${m ? ` [jump](<${PL.platform(link.platform).jump(link.guild_id, link.ext_channel_id, m.ext_message_id)}>)` : ''}\n${text}`;
  }
  for (const a of msg.attachments || []) if (a?.url) text += `\n${absUrl(a.url)}`;
  if (text.length > 2000) text = `${text.slice(0, 1990)}...`;
  const a = msg.author || {};
  const payload = {
    content: text, username: hookName(a.display_name || a.username), avatar_url: absUrl(a.pfp) || absUrl(config.get().icon_url) || undefined,
    allowed_mentions: { parse: [] }, embeds: msg.embeds?.length ? msg.embeds.slice(0, 10) : undefined,
  };
  if (!payload.content.trim() && !payload.embeds) return;
  let sent;
  try { sent = await execHook(link, payload); } catch (e) {
    if (e.status !== 404 && e.status !== 401) throw e;
    link.hook_id = null; link.hook_token = null; // the webhook was deleted over there: make a new one
    await ensureHook(link);
    sent = await execHook(link, payload);
  }
  if (sent?.id) {
    rememberOut(sent.id);
    db.run('INSERT OR IGNORE INTO bridge_msgs (message_id, platform, ext_message_id, ext_channel_id, outbound, created_at) VALUES (?, ?, ?, ?, 1, ?)', Number(msg.id), link.platform, String(sent.id), link.ext_channel_id, now());
  }
}
// messages.onEdit / onDelete: edits / deletes here go over too (deleting someone's Discord message needs Manage messages there)
function onEdit(msg, ctx) {
  for (const link of linksOfChannel(ctx.ch.id)) {
    if (!configured(link.platform)) continue;
    enqueue(`out:${ctx.ch.id}:${link.platform}`, async () => {
      const m = db.get('SELECT ext_message_id, outbound FROM bridge_msgs WHERE message_id = ? AND platform = ?', Number(msg.id), link.platform);
      const fresh = db.get('SELECT hook_id, hook_token FROM bridge_channels WHERE channel_id = ? AND bridge_id = ?', link.channel_id, link.bridge_id);
      if (!m || !m.outbound || !fresh?.hook_id) return;
      await PL.rest(link.platform, 'PATCH', `/webhooks/${fresh.hook_id}/${fresh.hook_token}/messages/${m.ext_message_id}`, { content: (await textOut(link, msg.body, ctx.c.id)).slice(0, 2000), allowed_mentions: { parse: [] } }, { auth: false });
    });
  }
}
function onDelete({ id, ch }) {
  for (const link of linksOfChannel(ch.id)) {
    if (!configured(link.platform)) continue;
    enqueue(`out:${ch.id}:${link.platform}`, async () => {
      const m = db.get('SELECT ext_message_id, outbound FROM bridge_msgs WHERE message_id = ? AND platform = ?', Number(id), link.platform);
      if (!m) return;
      db.run('DELETE FROM bridge_msgs WHERE message_id = ? AND platform = ?', Number(id), link.platform);
      const fresh = db.get('SELECT hook_id, hook_token FROM bridge_channels WHERE channel_id = ? AND bridge_id = ?', link.channel_id, link.bridge_id);
      if (m.outbound && fresh?.hook_id) await PL.rest(link.platform, 'DELETE', `/webhooks/${fresh.hook_id}/${fresh.hook_token}/messages/${m.ext_message_id}`, null, { auth: false }).catch(() => {});
      else await PL.rest(link.platform, 'DELETE', `/channels/${link.ext_channel_id}/messages/${m.ext_message_id}`).catch(() => {});
    });
  }
}

// ---------------------------------------------------------------- settings routes' logic (Manage server)
function manageable(me, sid) {
  const { c, snap } = C.memberCommunity(sid, me);
  if (!snap.can(me.id, P.MANAGE_SERVER)) throw err('not_allowed', 403);
  return { c, snap };
}
async function platforms() {
  const out = [];
  for (const p of PL.IDS) {
    const x = PL.platform(p);
    if (!configured(p)) { out.push({ id: p, name: x.name, ready: false, bot: null, invite: null, linked: true }); continue; }
    const bot = await botUser(p).catch(() => null);
    // `linked` is always true: it's the instance owner's own bot, there is no account to link (Velora checks a linked account)
    out.push({ id: p, name: x.name, ready: !!bot, bot: bot ? bot.username : null, invite: bot ? x.invite(bot.id) : null, linked: true });
  }
  return { platforms: out };
}
// the bot's servers over there (any of them can be linked: the bot is the owner's)
async function guilds(me, p) {
  const x = needPlatform(p);
  const c = db.get('SELECT sid FROM communities ORDER BY id LIMIT 1'); // the instance's one community (PROTOCOL §5a)
  if (!c) throw err('server_not_found', 404);
  manageable(me, c.sid);
  const list = await PL.rest(p, 'GET', '/users/@me/guilds');
  return { guilds: (Array.isArray(list) ? list : []).slice(0, 200).map(g => ({ id: String(g.id), name: g.name, icon: g.icon ? `${x.cdn}/icons/${g.id}/${g.icon}.png?size=96` : null })) };
}
async function status(me, sid) {
  const { c } = manageable(me, sid);
  store.ensure();
  const rows = db.all('SELECT * FROM bridge_guilds WHERE community_id = ? ORDER BY id', c.id);
  const bridges = await Promise.all(rows.map(async b => {
    const links = db.all('SELECT bc.*, ch.cid FROM bridge_channels bc JOIN channels ch ON ch.id = bc.channel_id WHERE bc.bridge_id = ?', b.id);
    let ext = [], problem = null;
    if (!configured(b.platform)) problem = 'bridge_not_set_up';
    else {
      try {
        const chans = await guildThing(b.platform, b.guild_id, 'channels', true);
        const cats = new Map(chans.filter(x => x.type === 4).map(x => [String(x.id), x.name]));
        ext = chans.filter(x => TEXTISH.includes(x.type)).sort((x, y) => x.position - y.position).map(x => ({ id: String(x.id), name: x.name, category: cats.get(String(x.parent_id)) || '' }));
      } catch (e) { problem = e.status === 404 || e.status === 403 ? 'bot_not_in_server' : 'unreachable'; }
    }
    return {
      platform: b.platform, platform_name: PL.platform(b.platform)?.name, guild_id: b.guild_id, guild_name: b.guild_name, enabled: !!b.enabled, problem,
      links: links.map(l => ({ cid: l.cid, ext_channel_id: l.ext_channel_id, ext_name: l.ext_name, hook: !!l.hook_id })),
      ext_channels: ext,
    };
  }));
  return { bridges, bridge: bridges[0] || null, links: bridges[0]?.links || [], ext_channels: bridges[0]?.ext_channels || [] };
}
const norm = n => String(n).toLowerCase().replace(/[^a-z0-9]/g, '');
async function link(me, sid, p, gid, automap = true) {
  const { c, snap } = manageable(me, sid);
  needPlatform(p);
  if (!/^\d{1,24}$/.test(String(gid))) throw err('bad_guild');
  store.ensure();
  if (db.get('SELECT 1 FROM bridge_guilds WHERE community_id = ? AND platform = ?', c.id, p)) throw err('already_bridged');
  let g;
  try { g = await guildThing(p, gid, '', true); } catch (e) { if (e.status === 404 || e.status === 403) throw err('bot_not_in_server', 404); throw err('platform_unreachable', 502); }
  const id = Number(db.run('INSERT INTO bridge_guilds (community_id, platform, guild_id, guild_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', c.id, p, String(gid), clean(g.name, 100), me.id, now()).lastInsertRowid);
  if (automap) { // same name (lowercase, letters and digits only) = linked
    const chans = (await guildThing(p, gid, 'channels', true).catch(() => [])).filter(x => TEXTISH.includes(x.type));
    for (const ch of snap.channels.filter(x => (x.type || 'text') === 'text')) {
      const m = chans.find(x => norm(x.name) === norm(ch.name));
      if (m && !linkByExt(p, m.id)) db.run('INSERT OR IGNORE INTO bridge_channels (channel_id, bridge_id, ext_channel_id, ext_name) VALUES (?, ?, ?, ?)', ch.id, id, String(m.id), clean(m.name, 100));
    }
    for (const l of db.all(`${LINK_SQL} WHERE bc.bridge_id = ?`, id)) await ensureHook(l).catch(e => console.error('[bridge] hook', e.message));
  }
  C.channelsChanged(c);
  return status(me, sid);
}
function bridgeRow(c, p) {
  store.ensure();
  if (!p) p = db.get('SELECT platform FROM bridge_guilds WHERE community_id = ? ORDER BY id LIMIT 1', c.id)?.platform;
  if (p && !PL.IDS.includes(p)) throw err('bad_platform', 404);
  return p ? db.get('SELECT * FROM bridge_guilds WHERE community_id = ? AND platform = ?', c.id, p) : null;
}
async function setEnabled(me, sid, p, on) {
  const { c } = manageable(me, sid);
  const b = bridgeRow(c, p);
  if (!b) throw err('not_bridged');
  db.run('UPDATE bridge_guilds SET enabled = ? WHERE id = ?', on ? 1 : 0, b.id);
  C.channelsChanged(c);
  return status(me, sid);
}
async function unlink(me, sid, p) {
  const { c } = manageable(me, sid);
  const b = bridgeRow(c, p);
  if (!b) return status(me, sid);
  for (const l of db.all('SELECT * FROM bridge_channels WHERE bridge_id = ?', b.id)) {
    if (l.hook_id && configured(b.platform)) await PL.rest(b.platform, 'DELETE', `/webhooks/${l.hook_id}/${l.hook_token}`, null, { auth: false }).catch(() => {});
  }
  db.run('DELETE FROM bridge_guilds WHERE id = ?', b.id);
  C.channelsChanged(c);
  return status(me, sid);
}
async function setChannel(me, sid, cid, p, extId) {
  const { c } = manageable(me, sid);
  const b = bridgeRow(c, p);
  if (!b) throw err('not_bridged');
  const { ch } = C.findChannel(cid, me);
  if (ch.community_id !== c.id) throw err('channel_not_found', 404);
  const old = db.get('SELECT * FROM bridge_channels WHERE channel_id = ? AND bridge_id = ?', ch.id, b.id);
  if (old?.hook_id && String(old.ext_channel_id) !== String(extId || '') && configured(b.platform)) await PL.rest(b.platform, 'DELETE', `/webhooks/${old.hook_id}/${old.hook_token}`, null, { auth: false }).catch(() => {});
  if (!extId) db.run('DELETE FROM bridge_channels WHERE channel_id = ? AND bridge_id = ?', ch.id, b.id);
  else {
    needPlatform(b.platform);
    if ((ch.type || 'text') !== 'text') throw err('text_channels_only');
    const chans = await guildThing(b.platform, b.guild_id, 'channels', true).catch(e => { throw err(e.status === 404 || e.status === 403 ? 'bot_not_in_server' : 'platform_unreachable', e.status === 404 ? 404 : 502); });
    const x = chans.find(y => String(y.id) === String(extId) && TEXTISH.includes(y.type));
    if (!x) throw err('channel_not_found', 404);
    const taken = linkByExt(b.platform, x.id);
    if (taken && taken.channel_id !== ch.id) throw err('already_linked');
    if (String(old?.ext_channel_id) !== String(x.id)) db.run('REPLACE INTO bridge_channels (channel_id, bridge_id, ext_channel_id, ext_name) VALUES (?, ?, ?, ?)', ch.id, b.id, String(x.id), clean(x.name, 100));
    const l = db.get(`${LINK_SQL} WHERE bc.channel_id = ? AND bc.bridge_id = ?`, ch.id, b.id);
    try { await ensureHook(l); } catch (e) { throw err(e.status === 403 ? 'bot_needs_webhooks' : 'bridge_failed'); }
  }
  C.channelsChanged(c);
  return status(me, sid);
}

// ---------------------------------------------------------------- lifecycle
let pruneTimer = null, unhook = [];
function init() {
  store.ensure();
  const M_ = M();
  unhook.forEach(f => f()); unhook = [M_.onPost(onPost), M_.onEdit(onEdit), M_.onDelete(onDelete)];
  for (const p of PL.IDS) if (configured(p)) startClient(p);
  clearInterval(pruneTimer);
  pruneTimer = setInterval(() => { try { db.run('DELETE FROM bridge_msgs WHERE created_at < ?', now() - RETENTION); } catch { /* closed */ } }, 6 * 3600e3);
  pruneTimer.unref();
  try { db.run('DELETE FROM bridge_msgs WHERE created_at < ?', now() - RETENTION); } catch { /* fine */ }
}
function shutdown() {
  clearInterval(pruneTimer);
  for (const p of [...clients.keys()]) stopClient(p);
  unhook.forEach(f => f()); unhook = [];
  log('[bridge] stopped');
}
const idle = () => Promise.all([...queues.values()]); // tests: wait for queued relays

module.exports = {
  init, shutdown, onEvent, onPost, onEdit, onDelete, channelTag, settingsView, saveSettings, platforms, guilds, status, link, setEnabled, unlink, setChannel,
  hookName, textIn, textOut, idle, clients, RETENTION,
};
