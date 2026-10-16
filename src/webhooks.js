'use strict';
// Webhooks: per-channel management (Manage channels) + the no-login Discord-compatible execute endpoint
// POST /api/v1/webhooks/:wid/:token (content, username, avatar_url, embeds[], or multipart with payload_json + files). The token is the key.
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const C = require('./communities');
const uploads = require('./uploads');
const { P } = require('./perms');
const { err, clean, randId, now, normalizeOrigin } = require('./util');

const MAX_PER_COMMUNITY = 30, RATE = 30, RATE_MS = 60000;
const M = () => require('./messages');
const origin = () => normalizeOrigin(config.publicUrl());
const token = () => crypto.randomBytes(32).toString('base64url');
const hookUrl = h => `${origin()}/api/v1/webhooks/${h.wid}/${h.token}`;
const hookView = h => {
  const ch = db.get('SELECT cid FROM channels WHERE id = ?', h.channel_id);
  const by = h.created_by ? db.get('SELECT username FROM users WHERE id = ?', h.created_by) : null;
  return { wid: h.wid, name: h.name, avatar: h.avatar || null, channel: ch?.cid, url: hookUrl(h), created_by: by?.username || null, created_at: h.created_at };
};
const hookable = ch => ['text', 'logs'].includes(ch.type || 'text');

function hookChannel(cid, me) {
  const r = C.findChannel(cid, me);
  if (!hookable(r.ch)) throw err('no_webhooks_here');
  if (!r.snap.can(me.id, P.MANAGE_CHANNELS)) throw err('not_allowed', 403);
  return r;
}
const list = (cid, me) => db.all('SELECT * FROM webhooks WHERE channel_id = ? ORDER BY id', hookChannel(cid, me).ch.id).map(hookView);
function create(cid, me, body) {
  const { ch, c } = hookChannel(cid, me);
  if (db.get('SELECT COUNT(*) AS n FROM webhooks WHERE community_id = ?', c.id).n >= MAX_PER_COMMUNITY) throw err('too_many_webhooks');
  const wid = randId('w');
  db.run('INSERT INTO webhooks (wid, token, community_id, channel_id, name, avatar, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', wid, token(), c.id, ch.id, clean(body?.name, 80) || 'Webhook', null, me.id, now());
  return hookView(db.get('SELECT * FROM webhooks WHERE wid = ?', wid));
}
function managed(wid, me) {
  const h = db.get('SELECT * FROM webhooks WHERE wid = ?', String(wid || ''));
  const ch = h && db.get('SELECT * FROM channels WHERE id = ?', h.channel_id);
  const c = ch && db.get('SELECT * FROM communities WHERE id = ?', ch.community_id);
  const snap = c && C.snapOf(c);
  if (!snap || !snap.isMember(me.id)) throw err('webhook_not_found', 404);
  if (!snap.can(me.id, P.MANAGE_CHANNELS)) throw err('not_allowed', 403);
  return { h, snap };
}
function update(wid, me, body = {}) {
  const { h } = managed(wid, me);
  const set = {};
  if (body.name !== undefined) set.name = clean(body.name, 80) || 'Webhook';
  if (body.avatar !== undefined) set.avatar = typeof body.avatar === 'string' && body.avatar.startsWith(origin() + '/uploads/') ? body.avatar.slice(0, 512) : null;
  if (body.new_token) set.token = token();
  if (body.channel !== undefined) {
    const { ch } = C.findChannel(body.channel, me);
    if (ch.community_id !== h.community_id || !hookable(ch)) throw err('no_webhooks_here');
    set.channel_id = ch.id;
  }
  if (Object.keys(set).length) db.run(`UPDATE webhooks SET ${Object.keys(set).map(k => k + ' = ?').join(', ')} WHERE id = ?`, ...Object.values(set), h.id);
  return hookView({ ...h, ...set });
}
function remove(wid, me) { db.run('DELETE FROM webhooks WHERE id = ?', managed(wid, me).h.id); }
async function setAvatar(wid, me, buffer) {
  managed(wid, me);
  if (!buffer) throw err('no_file');
  return update(wid, me, { avatar: uploads.saveImage(buffer, 'webhook') });
}

// ---- by token (no login) ----
function byToken(wid, tok) {
  const h = db.get('SELECT * FROM webhooks WHERE wid = ?', String(wid || ''));
  const a = Buffer.from(String(tok || '')), b = Buffer.from(h?.token || '');
  if (!h || !tok || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw err('Unknown Webhook', 404);
  return h;
}
function info(wid, tok) {
  const h = byToken(wid, tok);
  const ch = db.get('SELECT cid FROM channels WHERE id = ?', h.channel_id), c = db.get('SELECT sid FROM communities WHERE id = ?', h.community_id);
  return { id: h.wid, type: 1, name: h.name, avatar: h.avatar || null, channel_id: ch.cid, guild_id: c.sid, token: h.token };
}
function removeByToken(wid, tok) { db.run('DELETE FROM webhooks WHERE id = ?', byToken(wid, tok).id); }

function cleanEmbeds(list) {
  if (!Array.isArray(list)) return [];
  const url = v => (typeof v === 'string' && /^https?:\/\/\S+$/i.test(v) ? v.slice(0, 1024) : undefined);
  const str = (v, n) => (v == null || v === '' ? undefined : String(v).slice(0, n));
  const color = v => (Number.isInteger(v) ? v & 0xffffff : typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v) ? parseInt(v.replace('#', ''), 16) : undefined);
  return list.slice(0, 10).map(e => {
    if (!e || typeof e !== 'object') return null;
    const out = {
      title: str(e.title, 256), description: str(e.description, 4096), url: url(e.url), color: color(e.color),
      timestamp: e.timestamp && !Number.isNaN(Date.parse(e.timestamp)) ? new Date(e.timestamp).toISOString() : undefined,
      author: e.author?.name ? { name: str(e.author.name, 256), url: url(e.author.url), icon_url: url(e.author.icon_url) } : undefined,
      footer: e.footer?.text ? { text: str(e.footer.text, 2048), icon_url: url(e.footer.icon_url) } : undefined,
      image: url(e.image?.url) ? { url: url(e.image.url) } : undefined,
      thumbnail: url(e.thumbnail?.url) ? { url: url(e.thumbnail.url) } : undefined,
      fields: Array.isArray(e.fields) ? e.fields.slice(0, 25).filter(f => f && f.name != null && f.value != null).map(f => ({ name: str(f.name, 256) || '', value: str(f.value, 1024) || '', inline: !!f.inline })) : undefined,
    };
    const c2 = JSON.parse(JSON.stringify(out));
    if (c2.fields && !c2.fields.length) delete c2.fields;
    return Object.keys(c2).filter(k => k !== 'color').length ? c2 : null;
  }).filter(Boolean);
}
// files sent with a webhook / bot message (multipart): stored in the instance uploads dir; embeds can point at them with
// attachment://<filename> (like Discord - a file an embed uses isn't shown again as its own attachment)
function withFiles(files, embeds, userId = null) {
  const saved = (Array.isArray(files) ? files : []).slice(0, 10).map(f => {
    const u = uploads.storeUpload(f.buffer, f.filename, userId);
    return { name: String(f.filename || ''), att: { url: u.url, type: u.type, name: u.name, size: u.size, width: u.width, height: u.height, sha256: u.sha256 } };
  });
  if (!saved.length) return { atts: [], embeds };
  const used = new Set();
  const fix = v => {
    const m = /^attachment:\/\/(.+)$/.exec(String(v || ''));
    if (!m) return v;
    const a = saved.find(x => x.name === m[1]);
    if (a) used.add(a);
    return a ? a.att.url : undefined;
  };
  const out = Array.isArray(embeds) ? embeds.map(e => (e && typeof e === 'object' ? {
    ...e, image: e.image ? { ...e.image, url: fix(e.image.url) } : e.image, thumbnail: e.thumbnail ? { ...e.thumbnail, url: fix(e.thumbnail.url) } : e.thumbnail,
    author: e.author ? { ...e.author, icon_url: fix(e.author.icon_url) } : e.author, footer: e.footer ? { ...e.footer, icon_url: fix(e.footer.icon_url) } : e.footer,
  } : e)) : embeds;
  return { atts: saved.filter(x => !used.has(x)).map(x => x.att), embeds: out };
}

const times = new Map(); // wid -> [ms]
function execute(wid, tok, body, files) {
  const h = byToken(wid, tok);
  const t = now(), hits = (times.get(h.wid) || []).filter(x => t - x < RATE_MS);
  if (hits.length >= RATE) { times.set(h.wid, hits); throw err('rate_limited', 429, { retry_after: Math.ceil((RATE_MS - (t - hits[0])) / 1000) }); }
  hits.push(t); times.set(h.wid, hits);
  const ctx = M().ctxOf(db.get('SELECT * FROM channels WHERE id = ?', h.channel_id));
  body = body && typeof body === 'object' ? body : {};
  const fl = withFiles(files, body.embeds);
  const embeds = cleanEmbeds(fl.embeds);
  const content = String(body.content ?? '').slice(0, M().MSG_MAX);
  if (!content.trim() && !embeds.length && !fl.atts.length) throw err('Cannot send an empty message', 400);
  const avatar = typeof body.avatar_url === 'string' && /^https?:\/\/\S+$/i.test(body.avatar_url) ? body.avatar_url.slice(0, 512) : h.avatar;
  const msg = M().postWebhook(ctx, h, { body: content, username: body.username, avatar, embeds, attachments: fl.atts });
  return {
    id: msg.id, type: 0, channel_id: ctx.ch.cid, content: msg.body, embeds: msg.embeds, webhook_id: h.wid,
    attachments: (msg.attachments || []).map((a, i) => ({ id: String(i), filename: a.name, url: a.url, size: a.size })),
    author: { id: h.wid, username: msg.author.username, avatar: msg.author.pfp, bot: true }, timestamp: new Date(msg.created_at).toISOString(),
  };
}

module.exports = { list, create, update, remove, setAvatar, info, removeByToken, execute, cleanEmbeds, withFiles, MAX_PER_COMMUNITY };
