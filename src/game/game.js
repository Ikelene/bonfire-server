'use strict';
// Bonfire Link: Minecraft servers in this instance's community (the `game` channel type). Ported from Velora's game.js
// (PROTOCOL §18). This file is the data side: identities, links, game channel config, views, segments both ways,
// Minecraft -> Bonfire posting, unlinking, the audit log and retention. The live sockets are in gateway.js.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const auth = require('../auth');
const uploads = require('../uploads');
const { P } = require('../perms');
const { err, now, normalizeOrigin, log } = require('../util');

const C = () => require('../communities');
const M = () => require('../messages');
const GW = () => require('./gateway');
const gateway = () => require('../gateway');

const MAX_LINKS = 10;           // Minecraft servers per community
const PURPOSES = ['info', 'console', 'chat'];
const EVENT_KEYS = ['join', 'leave', 'death', 'advancement', 'switch', 'server'];
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const UNLINKED_TTL = 30 * 24 * 3600e3;
const AUDIT_TTL = 365 * 24 * 3600e3;
const origin = () => normalizeOrigin(config.publicUrl());

// ---------------------------------------------------------------- schema (own tables, not db.js migrations)
let made = null;
function ensure() {
  const raw = db.raw();
  if (!raw || made === raw) return;
  raw.exec(`
    CREATE TABLE IF NOT EXISTS game_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT, iid TEXT NOT NULL UNIQUE, pubkey TEXT NOT NULL UNIQUE, game TEXT NOT NULL DEFAULT 'minecraft',
      platform TEXT NOT NULL, software TEXT NOT NULL DEFAULT '', mc_version TEXT NOT NULL DEFAULT '', mod_version TEXT NOT NULL DEFAULT '',
      listing TEXT NOT NULL DEFAULT 'public', motd TEXT, icon_url TEXT, icon_sha256 TEXT, public_address TEXT NOT NULL DEFAULT '',
      last_status TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, created_ip_hash TEXT, last_ip_hash TEXT, banned INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS game_instances_ip ON game_instances(created_ip_hash, first_seen);
    CREATE INDEX IF NOT EXISTS game_instances_seen ON game_instances(last_seen);
    CREATE TABLE IF NOT EXISTS game_links (
      instance_id INTEGER PRIMARY KEY REFERENCES game_instances(id) ON DELETE CASCADE,
      community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE, linked_by INTEGER, linked_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS game_links_community ON game_links(community_id);
    CREATE TABLE IF NOT EXISTS game_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      instance_iid TEXT NOT NULL, user_id INTEGER, kind TEXT NOT NULL, command TEXT, status TEXT NOT NULL, output_preview TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS game_audit_community ON game_audit(community_id, id);
  `);
  made = raw;
}

// ---------------------------------------------------------------- identity
// iid = "g" + first 16 hex of sha256(SPKI DER); pairing tag = top 30 bits of sha256 bytes 8..11 as 6 Crockford chars
function identityOf(der) {
  const h = crypto.createHash('sha256').update(der).digest();
  const n = h.readUInt32BE(8) >>> 2;
  let tag = '';
  for (let i = 5; i >= 0; i--) tag += CROCKFORD[(n >>> (i * 5)) & 31];
  return { iid: 'g' + h.toString('hex').slice(0, 16), tag: `${tag.slice(0, 3)}-${tag.slice(3)}`, tagRaw: tag };
}
const normTag = v => String(v || '').toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');

const instanceRow = iid => { ensure(); return db.get('SELECT * FROM game_instances WHERE iid = ?', String(iid || '')) || null; };
const linkOfIid = iid => { ensure(); return db.get('SELECT l.* FROM game_links l JOIN game_instances i ON i.id = l.instance_id WHERE i.iid = ?', String(iid || '')) || null; };
const linksOf = communityId => { ensure(); return db.all('SELECT l.*, i.iid FROM game_links l JOIN game_instances i ON i.id = l.instance_id WHERE l.community_id = ? ORDER BY l.linked_at', communityId); };

// ---------------------------------------------------------------- segments
const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
const plainText = (v, n) => String(v ?? '').replace(/§[0-9a-fk-orx]/gi, '').replace(CTRL, '').replace(/\s+/g, ' ').trim().slice(0, n);
const HEX = /^#[0-9a-f]{6}$/i;
// a segment list from Minecraft (MOTD, status) -> safe to store / show. No links, hovers or obfuscation; 2 lines.
function cleanSegments(list, { maxSegs = 20, maxChars = 120, lines = 2, links = false } = {}) {
  const out = [];
  let used = 0, nl = 0;
  for (const s of (Array.isArray(list) ? list : []).slice(0, maxSegs)) {
    if (!s || typeof s !== 'object') continue;
    let text = String(s.text ?? '').replace(/§[0-9a-fk-orx]/gi, '').replace(/\r\n?/g, '\n').replace(CTRL, '').replace(/[ \t]+/g, ' ');
    const parts = text.split('\n');
    if (nl + parts.length - 1 >= lines) { text = parts.slice(0, Math.max(0, lines - nl)).join('\n'); nl = lines; } else nl += parts.length - 1;
    if (used + text.replace(/\n/g, '').length > maxChars) text = text.slice(0, Math.max(0, maxChars - used));
    if (!text) { if (nl >= lines || used >= maxChars) break; continue; }
    used += text.replace(/\n/g, '').length;
    const seg = { text };
    if (HEX.test(String(s.color || ''))) seg.color = String(s.color).toLowerCase();
    for (const k of ['b', 'i', 'u', 's']) if (s[k] === true) seg[k] = true;
    if (links && /^https:\/\/\S{1,500}$/.test(String(s.link || ''))) seg.link = String(s.link);
    out.push(seg);
    if (used >= maxChars || nl >= lines) break;
  }
  if (out.length) { out[0].text = out[0].text.replace(/^\s+/, ''); out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, ''); }
  return out.filter(s => s.text);
}
const segmentsPlain = segs => (segs || []).map(s => s.text).join('');
const motdOf = r => { try { return JSON.parse(r?.motd || '[]'); } catch { return []; } };
const nameOf = r => plainText(segmentsPlain(motdOf(r)).split('\n')[0], 80) || 'Minecraft server';

// a Bonfire message -> segments for the game (bold / italic / underline / strike / code, spoilers, mentions, links, emojis)
const MAX_SEG_CHARS = 400;
function toSegments(msg, snap) {
  const roles = snap.roles;
  let body = String(msg.body || '');
  body = body.replace(/^-# Forwarded from [^\n]*\n?/, '');
  const blocks = [];
  body = body.replace(/```(?:[\w+-]*\n)?([\s\S]*?)```/g, (_, code) => { blocks.push(code.replace(/\s+/g, ' ').trim()); return `\u0001${blocks.length - 1}\u0001`; });
  body = body.split('\n').map(l => l.replace(/^\s*#{1,3}\s+/, '').replace(/^\s*-#\s+/, '').replace(/^\s*>{1,3}\s?/, '').replace(/^(\s*)[-*]\s+/, '$1')).join(' ');
  body = body.replace(/<t:(\d{1,12})(?::[tTdDfFR])?>/g, (_, s) => new Date(Number(s) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC');
  body = body.replace(/\s+/g, ' ').trim();
  const out = [];
  const push = (text, style = {}) => {
    if (!text) return;
    const last = out[out.length - 1];
    const same = last && JSON.stringify({ ...last, text: '' }) === JSON.stringify({ ...style, text: '' });
    if (same && !style.link && !style.hover) last.text += text; else out.push({ text, ...style });
  };
  const RE = /\u0001(\d+)\u0001|`([^`]+)`|\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\|\|(.+?)\|\||\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|<@&(r[0-9a-f]{10})>|<a?:(\w{1,32}):e[0-9a-f]{10}>|(https?:\/\/[^\s<>]+)|(?<![\w@])@([A-Za-z0-9_.-]{2,32})/g;
  function parse(text, style) {
    let i = 0;
    for (const m of text.matchAll(new RegExp(RE.source, 'g'))) {
      push(text.slice(i, m.index), style);
      i = m.index + m[0].length;
      if (m[1] !== undefined) push(blocks[Number(m[1])] || '', { ...style, code: true });
      else if (m[2] !== undefined) push(m[2], { ...style, code: true });
      else if (m[3] !== undefined) push(m[3], { ...style, link: m[4], u: true });
      else if (m[5] !== undefined) parse(m[5], { ...style, b: true });
      else if (m[6] !== undefined) parse(m[6], { ...style, u: true });
      else if (m[7] !== undefined) parse(m[7], { ...style, s: true });
      else if (m[8] !== undefined) push('[spoiler]', { ...style, hover: plainText(m[8].replace(/\u0001\d+\u0001/g, ''), 200) });
      else if (m[9] !== undefined) parse(m[9], { ...style, i: true });
      else if (m[10] !== undefined) parse(m[10], { ...style, i: true });
      else if (m[11] !== undefined) { const r = roles.find(x => x.rid === m[11]); push(`@${r ? r.name : 'role'}`, { ...style, color: r?.color && HEX.test(r.color) ? r.color.toLowerCase() : '#8ab4ff' }); }
      else if (m[12] !== undefined) push(`:${m[12]}:`, style);
      else if (m[13] !== undefined) push(m[13], { ...style, link: m[13], u: true });
      else if (m[14] !== undefined) push(`@${m[14]}`, { ...style, color: '#8ab4ff' });
    }
    push(text.slice(i), style);
  }
  parse(body, {});
  for (const a of msg.attachments || []) {
    const kind = a.type === 'image' || a.type === 'gif' ? 'image' : a.type === 'video' ? 'video' : 'file';
    if (/^https?:\/\//.test(String(a.url || ''))) { push(' '); push(`[${kind}]`, { link: a.url, u: true }); }
  }
  if (!out.length && msg.embeds?.length) { const e = msg.embeds[0] || {}; push(`[embed] ${plainText(e.title || e.description || '', 80)}`.trim()); }
  let used = 0;
  const capped = [];
  for (const s of out) {
    if (used + s.text.length > MAX_SEG_CHARS) { capped.push({ ...s, text: s.text.slice(0, Math.max(0, MAX_SEG_CHARS - used - 3)) + '...' }); break; }
    capped.push(s);
    used += s.text.length;
  }
  return capped.filter(s => s.text);
}

// ---------------------------------------------------------------- game channels
const cfgOf = ch => { const c = ch?.config; if (c && typeof c === 'object') return c; try { return JSON.parse(c || '{}') || {}; } catch { return {}; } };
const eventsOf = cfg => Object.fromEntries(EVENT_KEYS.map(k => [k, cfg?.events?.[k] !== false]));
function gameChannelsOf(iid, purpose) {
  const link = linkOfIid(iid);
  if (!link) return [];
  return db.all("SELECT * FROM channels WHERE community_id = ? AND type = 'game' ORDER BY position, id", link.community_id)
    .filter(ch => cfgOf(ch).instance === iid && (!purpose || cfgOf(ch).purpose === purpose));
}
// what the game side should send: the chat relay when a synced-chat channel uses it, console lines when a console channel does
function flagsOf(iid) {
  const chat = gameChannelsOf(iid, 'chat');
  const events = chat.some(ch => { const e = eventsOf(cfgOf(ch)); return EVENT_KEYS.some(k => e[k]); });
  return { relay: { chat: chat.length > 0, events: chat.length > 0 && events }, console_stream: gameChannelsOf(iid, 'console').length > 0 };
}
// communities.cleanConfig delegates here for game channels. current = the channel row being edited (or null)
function cleanChannelConfig(raw, snap, me, current = null) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const cur = current && current.type === 'game' ? cfgOf(current) : {};
  const pick = k => (raw[k] !== undefined ? raw[k] : cur[k]);
  const game = String(pick('game') || 'minecraft');
  if (game !== 'minecraft') throw err('bad_game');
  let instance = pick('instance');
  instance = instance ? String(instance) : null;
  if (instance) {
    const link = linkOfIid(instance);
    if (!link || link.community_id !== snap.c.id) throw err('instance_not_linked');
  }
  let purpose = pick('purpose');
  purpose = purpose ? String(purpose) : null;
  if (purpose && !PURPOSES.includes(purpose)) throw err('bad_purpose');
  if (purpose === 'console' && !snap.can(me.id, P.MANAGE_SERVER)) throw err('not_allowed', 403);
  const ev = raw.events && typeof raw.events === 'object' ? raw.events : cur.events || {};
  const addr = pick('address');
  return {
    game, instance, purpose,
    events: Object.fromEntries(EVENT_KEYS.map(k => [k, ev[k] !== false])),
    address: addr == null ? '' : plainText(addr, 120),
    show_players: pick('show_players') !== false,
    show_server_tag: pick('show_server_tag') !== false,
  };
}
// the config every member sees (communities.publicConfig)
function publicChannelConfig(ch) {
  const cfg = cfgOf(ch);
  const inst = cfg.instance ? instanceRow(cfg.instance) : null;
  return {
    game: cfg.game || 'minecraft', instance: cfg.instance || null, purpose: cfg.purpose || null,
    setup: !!(cfg.instance && cfg.purpose), address: cfg.address || inst?.public_address || '',
    events: eventsOf(cfg), show_players: cfg.show_players !== false, show_server_tag: cfg.show_server_tag !== false,
    instance_name: inst ? nameOf(inst) : null, platform: inst?.platform || null,
  };
}
// import: game channels keep their settings but not their server link (links belong to the instance they were made on)
function importConfig(cfg) {
  cfg = cfg && typeof cfg === 'object' ? cfg : {};
  const ev = cfg.events && typeof cfg.events === 'object' ? cfg.events : {};
  return {
    game: 'minecraft', instance: null, purpose: PURPOSES.includes(cfg.purpose) ? cfg.purpose : null,
    events: Object.fromEntries(EVENT_KEYS.map(k => [k, ev[k] !== false])), address: plainText(cfg.address, 120),
    show_players: cfg.show_players !== false, show_server_tag: cfg.show_server_tag !== false,
  };
}
// a channel change (create / edit / delete): tell this community's game servers what to relay now
function channelsChanged(c) { for (const l of linksOf(c.id)) GW().pushConfig(l.iid); }

// ---------------------------------------------------------------- views
const linkedByName = l => (l?.linked_by ? auth.userById(l.linked_by)?.username || null : null);
function instanceView(r) {
  if (!r) return null;
  const link = db.get('SELECT * FROM game_links WHERE instance_id = ?', r.id);
  const live = GW().liveOf(r.iid);
  const st = GW().statusOf(r.iid);
  return {
    iid: r.iid, platform: r.platform, software: r.software, mc_version: r.mc_version, mod_version: r.mod_version,
    name: nameOf(r), motd: motdOf(r), icon: r.icon_url || null, public_address: r.public_address || '',
    online: !!live.online, last_seen: live.last_seen || r.last_seen,
    linked_by: linkedByName(link), linked_at: link ? link.linked_at : null,
    pairing_tag: identityOf(Buffer.from(r.pubkey, 'base64')).tag,
    backends: Array.isArray(st?.backends) ? st.backends.map(b => b.name) : undefined,
    channels: link ? gameChannelsOf(r.iid).map(ch => ({ cid: ch.cid, name: ch.name, purpose: cfgOf(ch).purpose || null })) : undefined,
  };
}
const communityInstances = communityId => linksOf(communityId).map(l => instanceView(instanceRow(l.iid))).filter(Boolean);
// a status as one channel may show it (info channels can hide the player list)
function statusForChannel(ch, iid) {
  const st = GW().statusOf(iid);
  if (!st) return null;
  const cfg = cfgOf(ch);
  if (cfg.purpose === 'info' && cfg.show_players === false) return { ...st, players: st.players ? { online: st.players.online, max: st.players.max } : undefined };
  return st;
}
// game_status to every game channel of the instance (one event each, so the gateway's per-channel visibility filter applies)
function broadcastStatus(iid) {
  const link = linkOfIid(iid);
  if (!link) return;
  const c = db.get('SELECT * FROM communities WHERE id = ?', link.community_id);
  if (!c) return;
  const live = GW().liveOf(iid);
  for (const ch of gameChannelsOf(iid)) gateway().emit(c.id, { type: 'game_status', server: c.sid, channel: ch.cid, instance: iid, status: statusForChannel(ch, iid), online: !!live.online, last_seen: live.last_seen || null });
}
function broadcastConsole(iid, lines) {
  const link = linkOfIid(iid);
  if (!link || !lines.length) return;
  const c = db.get('SELECT * FROM communities WHERE id = ?', link.community_id);
  if (!c) return;
  for (const ch of gameChannelsOf(iid, 'console')) gateway().emit(c.id, { type: 'game_console', server: c.sid, channel: ch.cid, instance: iid, lines });
}

// ---------------------------------------------------------------- linking
// who: { communityId, userId, username, cid? } (a claim code, or an admin picking it from the connected list)
function link(inst, who) {
  ensure();
  const c = db.get('SELECT * FROM communities WHERE id = ?', who.communityId);
  if (!c) throw err('not_allowed', 403);
  if (linksOf(c.id).length >= MAX_LINKS) throw err('too_many_instances');
  if (db.get('SELECT 1 FROM game_links WHERE instance_id = ?', inst.id)) throw err('already_linked');
  db.run('INSERT INTO game_links (instance_id, community_id, linked_by, linked_at) VALUES (?, ?, ?, ?)', inst.id, c.id, who.userId || null, now());
  audit(c.id, inst.iid, who.userId, 'link', null, 'ok', null);
  // the game channel the code / pick was made in (still without a server) gets this one
  if (who.cid) {
    const ch = db.get('SELECT * FROM channels WHERE cid = ?', who.cid);
    if (ch && ch.community_id === c.id && ch.type === 'game' && !cfgOf(ch).instance) {
      db.run('UPDATE channels SET config = ? WHERE id = ?', JSON.stringify({ ...cfgOf(ch), game: 'minecraft', instance: inst.iid }), ch.id);
      C().channelsChanged(c);
    }
  }
  return { c, view: instanceView(instanceRow(inst.iid)) };
}
// by = 'bonfire' (Server settings) | 'console' (`bonfire unlink confirm` on the game side)
function unlink(iid, by, user) {
  ensure();
  const inst = instanceRow(iid);
  const l = inst && db.get('SELECT * FROM game_links WHERE instance_id = ?', inst.id);
  if (!l) throw err('not_linked', 404);
  const c = db.get('SELECT * FROM communities WHERE id = ?', l.community_id);
  for (const ch of gameChannelsOf(iid)) {
    const cfg = cfgOf(ch);
    if (cfg.purpose === 'chat') {
      try { M().systemMessage(M().ctxOf(ch), by === 'console' ? 'This Minecraft server was unlinked from its server console.' : `This Minecraft server was unlinked by @${user?.username || 'someone'}.`, { sysKind: 'mc_unlink' }); } catch (e) { console.error('[game] unlink line', e.message); }
    }
    db.run('UPDATE channels SET config = ? WHERE id = ?', JSON.stringify({ ...cfg, instance: null, purpose: null }), ch.id);
  }
  db.run('DELETE FROM game_links WHERE instance_id = ?', inst.id);
  if (c) {
    audit(c.id, iid, user?.id || null, 'unlink', by === 'console' ? '[CONSOLE] bonfire unlink' : null, 'ok', null);
    C().channelsChanged(c);
    gateway().emit(c.id, { type: 'game_unlinked', server: c.sid, instance: iid });
  }
  GW().send(iid, 'unlinked', { by, username: by === 'console' ? 'CONSOLE' : user?.username || '' });
  GW().pushConfig(iid);
  return { ok: true };
}

// ---------------------------------------------------------------- audit
function audit(communityId, iid, userId, kind, command, status, output) {
  ensure();
  return Number(db.run('INSERT INTO game_audit (community_id, instance_iid, user_id, kind, command, status, output_preview, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    communityId, iid, userId || null, kind, command == null ? null : String(command).slice(0, 1000), status, output == null ? null : String(output).slice(0, 500), now()).lastInsertRowid);
}
function auditUpdate(id, status, output) { db.run('UPDATE game_audit SET status = ?, output_preview = ? WHERE id = ?', status, output == null ? null : String(output).slice(0, 500), id); }
function auditList(communityId, before) {
  ensure();
  const params = [communityId];
  let where = 'a.community_id = ?';
  if (Number(before) > 0) { where += ' AND a.id < ?'; params.push(Number(before)); }
  const rows = db.all(`SELECT a.*, u.username, u.pfp, u.principal FROM game_audit a LEFT JOIN users u ON u.id = a.user_id WHERE ${where} ORDER BY a.id DESC LIMIT 51`, ...params);
  return {
    entries: rows.slice(0, 50).map(r => ({
      id: String(r.id), kind: r.kind, command: r.command, status: r.status, output_preview: r.output_preview,
      user: r.user_id ? { id: r.principal || null, username: r.username || null, pfp: r.pfp || null } : null,
      instance: r.instance_iid, instance_name: instanceRow(r.instance_iid) ? nameOf(instanceRow(r.instance_iid)) : null, created_at: r.created_at,
    })),
    has_more: rows.length > 50,
  };
}

// ---------------------------------------------------------------- Minecraft -> Bonfire
const ZW = '\u200b';
// text from the game: no § codes / control characters, and nothing in it pings anyone
const cleanGameText = (t, n = 512) => String(t ?? '').replace(/§[0-9a-fk-orx]/gi, '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').slice(0, n)
  .replace(/<@&/g, `<${ZW}@&`).replace(/@/g, `@${ZW}`);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function headOf(d, size = 64) {
  const name = plainText(d.name, 32).replace(/^\./, '');
  const uuid = String(d.uuid || '').toLowerCase();
  const byName = d.bedrock === true || uuid.startsWith('00000000-0000-0000-') || (UUID_RE.test(uuid) && uuid[14] === '3') || !UUID_RE.test(uuid);
  return `https://mc-heads.net/avatar/${byName ? encodeURIComponent(name || 'MHF_Steve') : uuid}/${size}`;
}
const EVENT_KIND = { join: 'join', leave: 'leave', death: 'death', advancement: 'advancement', switch: 'switch', server_start: 'server', server_stop: 'server', backend_up: 'server', backend_down: 'server' };
const SYS_KIND = { join: 'mc_join', leave: 'mc_leave', death: 'mc_death', advancement: 'mc_adv', switch: 'mc_switch', server_start: 'mc_start', server_stop: 'mc_stop', backend_up: 'mc_start', backend_down: 'mc_stop' };
const mdSafe = t => String(t).replace(/[*_~|`\\[\]]/g, m => '\\' + m);
function eventBody(kind, d) {
  const name = plainText(d.name, 32);
  if (kind === 'join') return 'joined the game';
  if (kind === 'leave') return 'left the game';
  if (kind === 'death') { const t = plainText(d.text, 512) || 'died'; return name && t.startsWith(name + ' ') ? t.slice(name.length + 1) : t; }
  if (kind === 'advancement') {
    const a = d.advancement || {};
    const title = mdSafe(plainText(a.title, 120) || plainText(a.id, 120) || 'an advancement');
    if (a.frame === 'challenge') return `has completed the challenge **${title}**`;
    if (a.frame === 'goal') return `has reached the goal **${title}**`;
    return `has made the advancement **${title}**`;
  }
  if (kind === 'switch') return `moved from ${plainText(d.from, 40) || 'another server'} to ${plainText(d.server, 40) || 'another server'}`;
  if (kind === 'server_start') return 'Server started';
  if (kind === 'server_stop') return 'Server stopped';
  if (kind === 'backend_up') return `${plainText(d.server, 40) || 'A server'} is back online`;
  if (kind === 'backend_down') return `${plainText(d.server, 40) || 'A server'} went offline`;
  return null;
}
// op 'chat' / 'event' from the game: posted into every synced-chat channel that uses this instance
function postFromGame(iid, op, d) {
  const inst = instanceRow(iid);
  if (!inst || !linkOfIid(iid)) return 0;
  const chans = gameChannelsOf(iid, 'chat');
  let n = 0;
  if (op === 'chat') {
    const text = cleanGameText(d.text, 512).trim();
    if (!text) return 0;
    const display = plainText(d.display, 80) || plainText(d.name, 32) || 'Player';
    for (const ch of chans) {
      const from = cfgOf(ch).show_server_tag !== false && d.server ? plainText(d.server, 40) || null : null;
      try { M().postBridged(ch, { platform: 'minecraft', name: display, avatar: headOf(d), body: text, from }); n++; } catch (e) { console.error('[game] chat', e.message); }
    }
    return n;
  }
  const kind = String(d.kind || '');
  const key = EVENT_KIND[kind];
  const body = key && eventBody(kind, d);
  if (!body) return 0;
  const serverEvent = key === 'server';
  for (const ch of chans) {
    const cfg = cfgOf(ch);
    if (!eventsOf(cfg)[key]) continue;
    const from = cfg.show_server_tag !== false && d.server && !serverEvent ? plainText(d.server, 40) || null : null;
    const who = serverEvent ? { name: nameOf(inst), avatar: inst.icon_url || null } : { name: plainText(d.display, 80) || plainText(d.name, 32) || 'Player', avatar: headOf(d) };
    try { M().postBridged(ch, { platform: 'minecraft', name: who.name, avatar: who.avatar, body, from, sysKind: SYS_KIND[kind] }); n++; } catch (e) { console.error('[game] event', e.message); }
  }
  return n;
}
const skipNotes = new Map();
function noteSkipped(iid) {
  const t = now();
  if (t - (skipNotes.get(iid) || 0) < 60000) return;
  skipNotes.set(iid, t);
  for (const ch of gameChannelsOf(iid, 'chat')) { try { M().systemMessage(M().ctxOf(ch), 'Some Minecraft messages were skipped (too many at once).', { sysKind: 'mc_skip' }); } catch { /* gone */ } }
}

// ---------------------------------------------------------------- Bonfire -> Minecraft (messages.onPost)
function authorColor(snap, msg) {
  const a = msg.author;
  if (!a?.id) return null;
  const u = auth.userByPrincipal(a.id);
  if (!u) return null;
  const mine = snap.roleIds(u.id);
  const top = snap.roles.filter(r => mine.has(r.id) && r.color && HEX.test(r.color)).sort((x, y) => y.position - x.position)[0];
  return top ? top.color.toLowerCase() : null;
}
function onPost(msg, ctx, meta) {
  if (ctx.ch.type !== 'game' || meta.system || meta.bridged === 'minecraft') return;
  const cfg = cfgOf(ctx.ch);
  if (cfg.purpose !== 'chat' || !cfg.instance || !GW().isConnected(cfg.instance)) return;
  const segments = toSegments(msg, ctx.snap);
  if (!segments.length) return;
  const a = msg.author || {};
  GW().send(cfg.instance, 'chat', {
    id: String(msg.id), channel: ctx.ch.name,
    author: { username: plainText(a.display_name || a.username, 80) || 'Bonfire', color: authorColor(ctx.snap, msg), bot: !!a.bot, webhook: !!a.webhook, bridge: a.bridge && a.bridge !== 'minecraft' ? a.bridge : undefined },
    segments,
    reply: msg.reply ? { author: plainText(msg.reply.author?.username, 80) || 'Bonfire', text: plainText(msg.reply.body, 80) } : null,
  });
}

// ---------------------------------------------------------------- icons + retention
function saveIcon(iid, buf, sha) {
  const name = `${iid}-${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8)}.png`;
  uploads.writeStored(`game-icons/${name}`, buf);
  const url = `${origin()}/uploads/game-icons/${name}`;
  db.run('UPDATE game_instances SET icon_url = ?, icon_sha256 = ? WHERE iid = ?', url, sha, iid);
  return url;
}
// hourly: audit older than a year, unlinked identities not seen for 30 days (and not connected), icons nobody uses
function purge() {
  ensure();
  db.run('DELETE FROM game_audit WHERE created_at < ?', now() - AUDIT_TTL);
  const old = db.all('SELECT i.id, i.iid FROM game_instances i LEFT JOIN game_links l ON l.instance_id = i.id WHERE l.instance_id IS NULL AND i.last_seen < ? LIMIT 1000', now() - UNLINKED_TTL);
  const gone = old.filter(r => !GW().isConnected(r.iid));
  for (const r of gone) { db.run('DELETE FROM game_instances WHERE id = ?', r.id); GW().forget(r.iid); }
  try {
    const keep = new Set(db.all('SELECT icon_url FROM game_instances WHERE icon_url IS NOT NULL').map(r => path.basename(r.icon_url)));
    const dir = path.join(uploads.root(), 'game-icons');
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (f.endsWith('.png') && !keep.has(f)) fs.unlinkSync(path.join(dir, f));
  } catch { /* nothing to clean */ }
  if (gone.length) log(`[game] purged ${gone.length} unlinked Minecraft identities`);
  return { instances: gone.length };
}

module.exports = {
  ensure, identityOf, normTag, instanceRow, linkOfIid, linksOf, plainText, cleanSegments, segmentsPlain, motdOf, nameOf, toSegments,
  cfgOf, eventsOf, gameChannelsOf, flagsOf, cleanChannelConfig, publicChannelConfig, importConfig, channelsChanged,
  instanceView, communityInstances, statusForChannel, broadcastStatus, broadcastConsole, link, unlink, audit, auditUpdate, auditList,
  cleanGameText, headOf, eventBody, postFromGame, noteSkipped, onPost, saveIcon, purge, MAX_LINKS, PURPOSES, EVENT_KEYS,
};
