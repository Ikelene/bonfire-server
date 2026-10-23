'use strict';
// Messages: post / edit / delete / reactions / pins / read state / search, plus signature handling (PROTOCOL §8).
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const signing = require('./signing');
const gateway = require('./gateway');
const C = require('./communities');
const { P } = require('./perms');
const notify = require('./notify');
const { err, clean, limiter, normalizeOrigin } = require('./util');

const MSG_MAX = 4000;
const MAX_ATTACHMENTS = 10;
const MAX_PINS = 50;
const S = () => require('./settings');
const mod = () => require('./moderation');
const audit = () => require('./audit');
const sendLimit = limiter(8, 5000); // 8 messages / 5 s per user
const KLIPY = /^https:\/\/([a-z0-9-]+\.)*klipy\.com\//i;
const HEX64 = /^[0-9a-f]{64}$/;

// ---------- views ----------
const SELECT_MSG = `SELECT m.*, u.principal AS u_principal, u.kind AS u_kind, u.username AS u_username, u.display_name AS u_dn, u.pfp AS u_pfp, u.velora_id AS u_vid,
  su.username AS subject_username, su.principal AS subject_principal,
  r.id AS r_id, r.body AS r_body, r.system AS r_system, r.user_id AS r_user_id, r.author_name AS r_author_name, r.subject_user_id AS r_subject_user_id, r.subject_parts AS r_subject_parts,
  ru.principal AS r_principal, ru.kind AS r_kind, ru.username AS r_username, ru.display_name AS r_dn, ru.pfp AS r_pfp, ru.velora_id AS r_vid, rsu.username AS r_subject_username, rsu.principal AS r_subject_principal
  FROM messages m LEFT JOIN users u ON u.id = m.user_id
  LEFT JOIN messages r ON r.id = m.reply_to LEFT JOIN users ru ON ru.id = r.user_id
  LEFT JOIN users su ON su.id = m.subject_user_id LEFT JOIN users rsu ON rsu.id = r.subject_user_id`;

const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const parseParts = v => { const p = json(v, null); return Array.isArray(p) && p.length <= 1001 && p.includes(null) && p.every(x => x === null || typeof x === 'string') ? p : null; };
// system messages that name a person: the text stays readable, the subject carries the account
function identityView(subjectId, subjectParts, subjectName, subjectPrincipal, fallback) {
  const parts = parseParts(subjectParts);
  if (subjectId != null && parts) return { body: parts.map(p => (p === null ? (subjectName ? '@' + subjectName : 'Deleted account') : p)).join(''), subject: { id: subjectPrincipal, username: subjectName || null }, body_parts: parts };
  return { body: fallback };
}
const person = (principal, kind, username, dn, pfp, vid) => ({ id: principal, kind, username, display_name: dn, pfp: pfp || null, velora_id: vid || null, ...(kind === 'bot' ? { bot: true, ...(require('./auth').botVerified(principal) ? { verified: true } : {}) } : {}) });
// webhook / bridged posts: a name and picture, no account
const outsider = (name, avatar, bridge, from) => ({ id: null, kind: null, username: name, display_name: name, pfp: avatar || null, velora_id: null, name_only: true, webhook: true, ...(bridge ? { bridge } : {}), ...(from ? { bridge_from: from } : {}) });
// author.bridge_from (where a bridged post was relayed from: a Velocity backend, "Discord" via CloudLink...) lives in bridge/store.js
const bridgeFrom = id => { try { return require('./bridge/store').fromOf(id); } catch { return null; } };

function messageView(r, snap) {
  const c = snap.c;
  const author = r.system ? null
    : r.u_principal ? person(r.u_principal, r.u_kind, r.u_username, r.u_dn, r.u_pfp, r.u_vid)
    : (r.webhook_id || r.bridge) ? outsider(r.author_name || 'Webhook', r.author_avatar, r.bridge, r.bridge ? bridgeFrom(r.id) : null)
    : r.author_name ? { id: null, kind: null, username: r.author_name, display_name: r.author_name, pfp: r.author_avatar || null, velora_id: null, name_only: true } : null;
  const replyAuthor = r.r_system ? null
    : r.r_principal ? person(r.r_principal, r.r_kind, r.r_username, r.r_dn, r.r_pfp, r.r_vid)
    : r.r_author_name ? { id: null, kind: null, username: r.r_author_name, display_name: r.r_author_name, pfp: null, velora_id: null, name_only: true } : null;
  const rid = id => snap.roles.find(x => x.id === Number(id))?.rid;
  const rep = r.r_id ? identityView(r.r_subject_user_id, r.r_subject_parts, r.r_subject_username, r.r_subject_principal, r.r_body || '') : null;
  return {
    id: String(r.id), channel: snap.channels.find(ch => ch.id === r.channel_id)?.cid, server: c.sid, author,
    ...identityView(r.subject_user_id, r.subject_parts, r.subject_username, r.subject_principal, r.body),
    attachments: json(r.attachments, []), system: !!r.system, sys_kind: r.sys_kind || undefined, pinned: !!r.pinned_at, embeds: json(r.embeds, undefined),
    reply_to: r.reply_to == null ? null : String(r.reply_to),
    reply: r.r_id ? { id: String(r.r_id), author: replyAuthor, ...rep, body: rep.body.slice(0, 200) } : null,
    mention_everyone: r.mention_everyone === 1 ? 'everyone' : r.mention_everyone === 2 ? 'here' : null,
    mention_roles: r.mention_roles ? String(r.mention_roles).split(',').filter(Boolean).map(rid).filter(Boolean) : [],
    created_at: r.created_at, edited_at: r.edited_at || null,
    signature: r.sig_kid ? { kid: r.sig_kid, sig: r.sig_sig, ts: r.sig_ts, nonce: r.sig_nonce } : null,
    verified: r.sig_kid ? (r.verified == null ? null : !!r.verified) : null,
    ...(r.bridge ? { bridge: r.bridge } : {}),
  };
}
const customReaction = raw => /^(?:c:)?(e[0-9a-f]{10})$/.exec(raw)?.[1]
  || /^<(?:a?):\w{1,32}:(e[0-9a-f]{10})>$/.exec(raw)?.[1]
  || /^\w{1,32}:(e[0-9a-f]{10})$/.exec(raw)?.[1];
const reactionKey = raw => customReaction(raw) ? `c:${customReaction(raw)}` : raw;
function reactionImage(raw, emojis) {
  const id = customReaction(raw);
  if (!id) return {};
  const e = emojis.get(id);
  const name = e?.name || /^<(?:a?):(\w+):/.exec(raw)?.[1] || 'deleted_emoji';
  return { emoji_id: id, name, url: e ? `${normalizeOrigin(config.publicUrl())}/uploads/${e.file}` : null, animated: !!e?.animated };
}
// reactions: [{ emoji, count, users: [first 25 usernames], user_ids: [their principals] }] in the order they were first added
function reactionsFor(ids) {
  const out = new Map();
  ids = ids.map(Number).filter(Boolean);
  if (!ids.length) return out;
  const rows = db.raw().prepare(`SELECT r.message_id, r.emoji, u.username, u.principal FROM reactions r JOIN users u ON u.id = r.user_id WHERE r.message_id IN (${db.inList(ids)}) ORDER BY r.created_at, r.rowid`).all(...ids);
  const emojiIds = [...new Set(rows.map(r => customReaction(r.emoji)).filter(Boolean))];
  const emojis = new Map(emojiIds.length ? db.all(`SELECT * FROM emojis WHERE eid IN (${db.inList(emojiIds)})`, ...emojiIds).map(e => [e.eid, e]) : []);
  const seen = new Set();
  for (const r of rows) {
    const key = reactionKey(r.emoji), identity = `${r.message_id}|${key}|${r.principal}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (!out.has(r.message_id)) out.set(r.message_id, []);
    const list = out.get(r.message_id);
    let e = list.find(x => x.emoji === key);
    if (!e) { e = { emoji: key, ...reactionImage(r.emoji, emojis), count: 0, users: [], user_ids: [] }; list.push(e); }
    e.count++;
    if (e.users.length < 25) { e.users.push(r.username); e.user_ids.push(r.principal); }
  }
  return out;
}
function withReactions(msgs) {
  const map = reactionsFor(msgs.map(m => m.id));
  msgs.forEach(m => { const r = map.get(Number(m.id)); if (r) m.reactions = r; });
  return msgs;
}
const viewById = (id, snap) => messageView(db.get(`${SELECT_MSG} WHERE m.id = ?`, id), snap);

// ---------- lookup ----------
function messageCtx(id, me) {
  if (!/^\d{1,15}$/.test(String(id))) throw err('message_not_found', 404);
  const r = db.get('SELECT * FROM messages WHERE id = ?', Number(id));
  const ch = r && db.get('SELECT * FROM channels WHERE id = ?', r.channel_id);
  if (!ch) throw err('message_not_found', 404);
  const c = db.get('SELECT * FROM communities WHERE id = ?', ch.community_id);
  const snap = C.snapOf(c);
  if (!snap.isMember(me.id) || !snap.canView(ch, me.id)) throw err('message_not_found', 404);
  return { r, ch, c, snap };
}

// ---------- attachments ----------
function cleanAttachments(list) {
  if (!Array.isArray(list)) return [];
  const origin = normalizeOrigin(config.publicUrl());
  const out = [];
  for (const a of list.slice(0, MAX_ATTACHMENTS)) {
    const url = String(a?.url || '');
    let u; try { u = new URL(url); } catch { continue; }
    if (u.origin === origin && u.pathname.startsWith('/uploads/')) { // our own upload: trust our records, not the client
      let rel; try { rel = decodeURIComponent(u.pathname.slice('/uploads/'.length)); } catch { continue; }
      const up = db.get('SELECT * FROM uploads WHERE path = ?', rel);
      if (!up) continue;
      out.push({ url: `${origin}/uploads/${up.path}`, type: up.type, name: up.name, size: up.size, width: up.width || undefined, height: up.height || undefined, sha256: up.sha256 });
    } else if (KLIPY.test(url)) {
      out.push({ url: url.slice(0, 512), type: 'gif', name: clean(a.name, 120), size: Number(a.size) || undefined, width: Number(a.width) || undefined, height: Number(a.height) || undefined, sha256: HEX64.test(String(a.sha256 || '')) ? a.sha256 : undefined });
    }
  }
  return out;
}

// ---------- signing ----------
// -> signature row fields to store, or null when unsigned. Throws API errors.
async function checkSignature({ me, c, ch, signature, scopes, body, attachments, replyTo, editOf, system = false }) {
  const velora = me && me.kind === 'velora';
  if (!signature) return null; // signing is optional, never required
  if (config.mode() !== 'velora' || !velora) throw err('signing_unavailable', 400);
  if (!scopes?.includes('sign')) throw err('insufficient_scope', 403);
  let hashes;
  try { hashes = signing.attachmentRefs(attachments); } catch { throw err('bad_signature', 400); }
  const payload = signing.buildPayload({
    iss: signing.issuer(), instance: normalizeOrigin(config.publicUrl()), community: c.sid, channel: ch.cid, author: me.velora_id,
    ts: signature.ts, nonce: signature.nonce, body, attachments: hashes, reply_to: replyTo, edit_of: editOf,
  });
  const res = await signing.verify({ payload, signature, veloraId: me.velora_id });
  if (!res.ok) throw err('bad_signature', 400, { reason: res.reason });
  return { sig_kid: signature.kid, sig_sig: signature.sig, sig_ts: Number(signature.ts), sig_nonce: String(signature.nonce), verified: 1 };
}
const normBody = text => String(text ?? '').replace(/\r\n/g, '\n').slice(0, MSG_MAX);
// Server settings > Message rules: a server that lowered the longest message refuses longer ones (the default, MSG_MAX, still trims)
function assertLength(c, text) {
  const max = S().get(c).messages.max_length;
  if (max < MSG_MAX && String(text ?? '').replace(/\r\n/g, '\n').length > max) throw err('message_too_long', 400, { max });
}

// ---------- posting ----------
function insertMessage(ctx, f) {
  require('./managed').assertWritable(); // every way of posting ends here: users, bots, webhooks, bridges, Ember Link
  const { ch, c, snap } = ctx;
  const res = db.run(
    `INSERT INTO messages (channel_id, user_id, body, reply_to, attachments, system, sys_kind, subject_user_id, subject_parts, mention_everyone, mention_roles, author_name, author_avatar, created_at, sig_kid, sig_sig, sig_ts, sig_nonce, verified, embeds, webhook_id, bridge, via)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ch.id, f.userId ?? null, f.body, f.replyTo ?? null, f.attachments?.length ? JSON.stringify(f.attachments) : null, f.system ? 1 : 0, f.sysKind || null,
    f.subjectId ?? null, f.subjectParts ? JSON.stringify(f.subjectParts) : null, f.everyone || 0, f.roleIds?.length ? ',' + f.roleIds.join(',') + ',' : null,
    f.authorName || null, f.authorAvatar || null, Date.now(), f.sig?.sig_kid ?? null, f.sig?.sig_sig ?? null, f.sig?.sig_ts ?? null, f.sig?.sig_nonce ?? null, f.sig?.verified ?? null,
    f.embeds?.length ? JSON.stringify(f.embeds) : null, f.webhookId ?? null, f.bridge || null, f.via ? JSON.stringify(f.via) : null);
  const id = Number(res.lastInsertRowid);
  if (f.bridge && f.bridgeFrom) require('./bridge/store').setFrom(id, f.bridgeFrom);
  db.run('UPDATE channels SET last_message_id = ? WHERE id = ?', id, ch.id);
  ch.last_message_id = id;
  if (f.userId && !f.system) db.run('INSERT INTO read_state (user_id, channel_id, last_read_id) VALUES (?, ?, ?) ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = excluded.last_read_id', f.userId, ch.id, id);
  const msg = viewById(id, snap);
  gateway.emit(c.id, { type: 'chat_message', message: msg, __via: f.via || null });
  afterPost(ctx, msg, f);
  return msg;
}

// ---------- extension points ----------
// onPost(fn): fn(message, ctx, meta) runs after ANY message is created (user, bot, webhook, system, bridged);
// ctx = { ch, c, snap }, meta = { system, webhook, bridged: platform | null, userId }. Returns an unsubscribe function.
const postHooks = [];
const onPost = fn => { postHooks.push(fn); return () => { const i = postHooks.indexOf(fn); if (i >= 0) postHooks.splice(i, 1); }; };
// onEdit(fn): fn(message, ctx) after a message's text changes; onDelete(fn): fn({ id, ch, c }) after one is deleted (bridges mirror them)
const editHooks = [], deleteHooks = [];
const hookList = list => fn => { list.push(fn); return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }; };
const onEdit = hookList(editHooks), onDelete = hookList(deleteHooks);
function runHooks(list, ...args) { for (const fn of list) { try { const r = fn(...args); if (r?.catch) r.catch(e => console.error('[messages] hook', e.message)); } catch (e) { console.error('[messages] hook', e.message); } } }
function afterPost(ctx, msg, f) {
  const meta = { system: !!f.system, webhook: !!f.webhookId, bridged: f.bridge || null, userId: f.userId ?? null };
  if (!meta.system && !meta.webhook && !meta.bridged) { try { notify.deliver(ctx, msg, f.userId); } catch (e) { console.error('[messages] mentions', e.message); } }
  for (const fn of postHooks) { try { const r = fn(msg, ctx, meta); if (r?.catch) r.catch(e => console.error('[messages] onPost', e.message)); } catch (e) { console.error('[messages] onPost', e.message); } }
}
// a channel row / cid / ctx -> ctx
function ctxOf(channel) {
  if (channel?.ch && channel?.c) return channel.snap ? channel : { ...channel, snap: C.snapOf(channel.c) };
  const ch = typeof channel === 'string' ? db.get('SELECT * FROM channels WHERE cid = ?', channel) : channel;
  const c = ch && db.get('SELECT * FROM communities WHERE id = ?', ch.community_id);
  if (!c) throw err('channel_not_found', 404);
  const snap = C.snapOf(c);
  return { ch: snap.channel(ch.id) || ch, c, snap };
}
// a message from outside (Discord / Fluxer / CloudLink bridges ...): { platform, name, avatar, body, attachments }
// attachments are trusted as-is (the bridge validated them): [{ url, type, name, size, width, height }]
// optional: replyTo (a message id in the same channel), from (author.bridge_from), sysKind (e.g. mc_join for game events)
function postBridged(channel, { platform, name, avatar, body, attachments, embeds, replyTo, from, sysKind } = {}) {
  const ctx = ctxOf(channel);
  const text = normBody(body);
  const atts = (Array.isArray(attachments) ? attachments : []).slice(0, MAX_ATTACHMENTS).filter(a => /^https?:\/\//i.test(String(a?.url || '')))
    .map(a => ({ url: String(a.url).slice(0, 1024), type: ['image', 'gif', 'video', 'audio', 'file'].includes(a.type) ? a.type : 'file', name: clean(a.name, 120), size: Number(a.size) || undefined, width: Number(a.width) || undefined, height: Number(a.height) || undefined }));
  if (!text.trim() && !atts.length && !embeds?.length) throw err('empty_message');
  const reply = replyTo != null && /^\d{1,15}$/.test(String(replyTo)) ? db.get('SELECT id FROM messages WHERE id = ? AND channel_id = ?', Number(replyTo), ctx.ch.id)?.id ?? null : null;
  return insertMessage(ctx, {
    body: text, attachments: atts, embeds, bridge: clean(platform, 20) || 'bridge', authorName: clean(name, 80) || 'Unknown', authorAvatar: /^https?:\/\/\S+$/i.test(avatar || '') ? String(avatar).slice(0, 512) : null,
    replyTo: reply, bridgeFrom: from ? clean(from, 40) : null, sysKind: sysKind ? clean(sysKind, 12) : null,
  });
}
// a bridged message changed / was deleted where it came from (only rows with a `bridge`)
function editBridged(id, body) {
  const r = db.get('SELECT * FROM messages WHERE id = ? AND bridge IS NOT NULL', Number(id));
  if (!r) return null;
  const text = normBody(body);
  if (text === r.body || !text.trim()) return null; // Discord / Fluxer send an update when they add a link preview: same text, not an edit
  db.run('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?', text, Date.now(), r.id);
  const ctx = ctxOf(db.get('SELECT * FROM channels WHERE id = ?', r.channel_id));
  const msg = viewById(r.id, ctx.snap);
  gateway.emit(ctx.c.id, { type: 'chat_message_update', message: msg });
  runHooks(editHooks, msg, ctx);
  return msg;
}
function deleteBridged(id) {
  const r = db.get('SELECT * FROM messages WHERE id = ? AND bridge IS NOT NULL', Number(id));
  if (!r) return false;
  const ch = db.get('SELECT * FROM channels WHERE id = ?', r.channel_id);
  const c = db.get('SELECT * FROM communities WHERE id = ?', ch.community_id);
  db.run('DELETE FROM messages WHERE id = ?', r.id);
  gateway.emit(c.id, { type: 'chat_message_delete', channel: ch.cid, server: c.sid, id: String(r.id) });
  runHooks(deleteHooks, { id: String(r.id), ch, c });
  return true;
}
// a webhook post (no account, no permission checks): see webhooks.js
function postWebhook(ctx, hook, { body, username, avatar, embeds, attachments }) {
  return insertMessage(ctx, { body: normBody(body), embeds, attachments, webhookId: hook.id, authorName: clean(username, 80) || hook.name, authorAvatar: avatar || hook.avatar || null });
}

// ctx = { ch, c, snap } (from C.findChannel)
async function postMessage(me, ctx, text, { replyTo, attachments, signature, scopes, embeds, origin } = {}) {
  const { ch, c, snap } = ctx;
  const body = normBody(text);
  const atts = cleanAttachments(attachments);
  if (!body.trim() && !atts.length && !embeds?.length) throw err('empty_message');
  if (!snap.isMember(me.id)) throw err('not_a_member', 403);
  if (!snap.canPost(ch, me.id)) throw err(ch.locked && ch.type !== 'voice' ? 'channel_locked' : 'no_send_permission', 403);
  if (atts.length && !(snap.chPerms(ch, me.id) & P.ATTACH)) throw err('no_attach_permission', 403);
  assertLength(c, text);
  mod().beforePost(ctx, me, body); // timeouts, AutoMod's blocked words and spam limits
  if (!sendLimit.hit(me.id)) throw err('rate_limited', 429);
  let reply = null;
  if (replyTo != null && /^\d{1,15}$/.test(String(replyTo))) reply = db.get('SELECT id FROM messages WHERE id = ? AND channel_id = ?', Number(replyTo), ch.id)?.id ?? null;
  const sig = await checkSignature({ me, c, ch, signature, scopes, body, attachments: atts, replyTo: reply, editOf: null });
  // @everyone / @here and role mentions only count when allowed (Mention everyone, or a mentionable role)
  const big = snap.can(me.id, P.MENTION_EVERYONE);
  let everyone = 0;
  if (big && /(^|\s)@everyone\b/.test(body)) everyone = 1; else if (big && /(^|\s)@here\b/.test(body)) everyone = 2;
  const tokens = [...body.matchAll(/<@&(r[0-9a-f]{10})>/g)].map(m => m[1]);
  const roleIds = snap.roles.filter(r => tokens.includes(r.rid) && !r.is_default && (r.mentionable || big)).map(r => r.id).slice(0, 20);
  return insertMessage(ctx, { userId: me.id, body, replyTo: reply, attachments: atts, everyone, roleIds, sig, embeds, via: viaOf(origin) });
}
function systemMessage(ctx, body, extra = {}) { return insertMessage(ctx, { system: true, body, ...extra }); }

async function editMessage(id, me, text, { signature, scopes } = {}) {
  const { r, ch, c, snap } = messageCtx(id, me);
  if (Number(r.user_id) !== Number(me.id)) throw err('not_allowed', 403);
  const body = normBody(text);
  if (!body.trim() && !r.attachments) throw err('empty_message');
  assertLength(c, text);
  if (body !== r.body) mod().beforePost({ ch, c, snap }, me, body, { edit: true });
  const atts = json(r.attachments, []);
  const sig = await checkSignature({ me, c, ch, signature, scopes, body, attachments: atts, replyTo: r.reply_to, editOf: r.id });
  db.run('UPDATE messages SET body = ?, edited_at = ?, sig_kid = ?, sig_sig = ?, sig_ts = ?, sig_nonce = ?, verified = ? WHERE id = ?',
    body, Date.now(), sig?.sig_kid ?? null, sig?.sig_sig ?? null, sig?.sig_ts ?? null, sig?.sig_nonce ?? null, sig?.verified ?? null, r.id);
  const msg = viewById(r.id, snap);
  gateway.emit(c.id, { type: 'chat_message_update', message: msg, __via: parseVia(r.via) });
  runHooks(editHooks, msg, { ch, c, snap });
  return msg;
}
function deleteMessage(id, me) {
  const { r, ch, c, snap } = messageCtx(id, me);
  if (Number(r.user_id) !== Number(me.id) && !snap.can(me.id, P.MANAGE_MESSAGES)) throw err('not_allowed', 403);
  db.run('DELETE FROM messages WHERE id = ?', r.id);
  gateway.emit(c.id, { type: 'chat_message_delete', channel: ch.cid, server: c.sid, id: String(r.id) });
  runHooks(deleteHooks, { id: String(r.id), ch, c });
  if (Number(r.user_id) !== Number(me.id)) {
    const author = r.user_id ? auth.userById(r.user_id) : null;
    audit().record(c, me, 'message_delete', { target: author ? { kind: 'user', id: author.principal, name: author.username } : { kind: 'message', id: r.id, name: r.author_name }, details: { channel: ch.name, body: String(r.body || '').slice(0, 300) } });
  }
}

// ---------- reactions ----------
const UNI_REACT = /^(\p{Regional_Indicator}{2}|[#*0-9]️?⃣|\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*)$/u;
// emoji = a standard emoji, or a custom one as <:name:eid> / eid / name:eid
function react(id, me, emojiRaw, on) {
  const { r, ch, c, snap } = messageCtx(id, me);
  if (on) { const until = mod().timeoutUntil(c, me.id); if (until) throw err('timed_out', 403, { until }); } // (taking one off is fine)
  let emoji = String(emojiRaw || '').trim();
  let eid = customReaction(emoji);
  // Also accept the composer's :name: spelling within this community.
  if (!eid && /^:[\w]{1,32}:$/.test(emoji)) eid = db.get('SELECT eid FROM emojis WHERE community_id = ? AND name = ? ORDER BY id LIMIT 1', c.id, emoji.slice(1, -1))?.eid;
  if (eid) {
    const e = db.get('SELECT * FROM emojis WHERE eid = ?', eid);
    if (on && (!e || e.community_id !== c.id)) throw err('unknown_emoji');
    const key = `c:${eid}`;
    const existing = db.all('SELECT emoji FROM reactions WHERE message_id = ? AND user_id = ?', r.id, me.id).filter(x => reactionKey(x.emoji) === key);
    if (on && existing.length) return;
    if (on) {
      if ((reactionsFor([r.id]).get(r.id) || []).filter(x => x.emoji !== key).length >= S().get(c).messages.max_reactions) throw err('too_many_reactions');
      db.run('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', r.id, me.id, `<${e.animated ? 'a' : ''}:${e.name}:${eid}>`, Date.now());
    } else {
      if (!existing.length) return;
      db.tx(() => { for (const x of existing) db.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', r.id, me.id, x.emoji); });
    }
    emoji = key;
  } else {
    if (!UNI_REACT.test(emoji) || emoji.length > 32) throw err('unknown_emoji');
    if (emoji === '\u2b50\ufe0f') emoji = '\u2b50';
    if (on) {
      if ((reactionsFor([r.id]).get(r.id) || []).filter(x => x.emoji !== emoji).length >= S().get(c).messages.max_reactions) throw err('too_many_reactions');
      if (!db.run('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', r.id, me.id, emoji, Date.now()).changes) return;
    } else if (!db.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', r.id, me.id, emoji).changes) return;
  }
  const list = reactionsFor([r.id]).get(r.id) || [];
  gateway.emit(c.id, { type: 'chat_reactions', server: c.sid, channel: ch.cid, id: String(r.id), reactions: list, emoji, username: me.username, user_id: me.principal, add: !!on });
  if (emoji === '\u2b50') require('./starboard').onStar({ ch, c, snap }, r.id, list.find(x => x.emoji === '\u2b50')?.count || 0);
}

// ---------- which page a message was sent from (Manage users) ----------
// Stored with the message as { url }, the Origin of the request (never an IP address). Only the copies that go to people
// with Manage users carry it (`via`); messageView never does, so bots, bridges, exports and everyone else see nothing.
const viaOf = origin => { const url = origin ? normalizeOrigin(origin) : null; return url && !/^https?:\/\/([\d.]+|\[.*\])(:|$)/.test(url) ? { url: url.slice(0, 120) } : null; };
function parseVia(v) { try { return v ? JSON.parse(v) : null; } catch { return null; } }
function attachVia(rows, snap, me, msgs) {
  if (!snap.can(me.id, P.MANAGE_USERS)) return msgs;
  msgs.forEach((m, i) => { const v = parseVia(rows[i]?.via); if (v) m.via = v; });
  return msgs;
}

// ---------- history / search / pins / read ----------
function history(cid, me, { before, after, limit } = {}) {
  const ctx = C.findChannel(cid, me);
  limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  let where = 'm.channel_id = ?';
  const params = [ctx.ch.id];
  if (before && /^\d{1,15}$/.test(String(before))) { where += ' AND m.id < ?'; params.push(Number(before)); }
  if (after && /^\d{1,15}$/.test(String(after))) { where += ' AND m.id > ?'; params.push(Number(after)); }
  const rows = db.all(`${SELECT_MSG} WHERE ${where} ORDER BY m.id ${after ? 'ASC' : 'DESC'} LIMIT ?`, ...params, limit);
  if (!after) rows.reverse();
  return { channel: C.channelView(ctx.snap, ctx.ch), messages: attachVia(rows, ctx.snap, me, withReactions(rows.map(r => messageView(r, ctx.snap)))), has_more: rows.length === limit };
}
const likeEsc = s => s.replace(/[\\%_]/g, x => '\\' + x);
function search(cid, me, q) {
  const { ch, c, snap } = C.findChannel(cid, me);
  q = String(q || '').trim().slice(0, 100);
  if (!q) return { messages: [] };
  const rows = db.all(`${SELECT_MSG} WHERE m.channel_id = ? AND m.body LIKE ? ESCAPE '\\' ORDER BY m.id DESC LIMIT ?`, ch.id, `%${likeEsc(q)}%`, S().get(c).messages.search_results);
  return { messages: rows.map(r => messageView(r, snap)) };
}
// whole community: from:name in:channel has:image|video|file|link|embed|sound|audio
function searchServer(sid, me, raw, { offset } = {}) {
  const { c, snap } = C.memberCommunity(sid, me);
  const per = S().get(c).messages.search_results;
  let q = String(raw || '').slice(0, 200);
  const take = re => { const out = []; q = q.replace(re, (all, v) => { out.push(v.toLowerCase()); return ' '; }); return out; };
  const from = take(/(?:^|\s)from:@?([\w.-]{2,32})/gi);
  const inCh = take(/(?:^|\s)in:#?([a-z0-9_-]{1,40})/gi);
  const has = take(/(?:^|\s)has:(image|video|file|link|embed|sound|audio)/gi);
  q = q.trim();
  let list = snap.visible(me.id).filter(c => !['voice', 'link', 'roles', 'starboard'].includes(c.type) && !(c.type === 'game' && C.cfgOf(c).purpose !== 'chat'));
  if (inCh.length) list = list.filter(c => inCh.includes(c.name.toLowerCase()));
  if (!list.length || (!q && !from.length && !has.length)) return { messages: [], total: 0 };
  let where = `m.channel_id IN (${db.inList(list)}) AND m.system = 0`;
  const params = list.map(c => c.id);
  if (q) { where += " AND m.body LIKE ? ESCAPE '\\'"; params.push(`%${likeEsc(q)}%`); }
  if (from.length) { where += ` AND (LOWER(u.username) IN (${db.inList(from)}) OR LOWER(m.author_name) IN (${db.inList(from)}))`; params.push(...from, ...from); }
  for (const h of has) {
    if (h === 'image') where += ` AND (m.attachments LIKE '%"type":"image"%' OR m.attachments LIKE '%"type":"gif"%' OR m.body LIKE '%https://%.png%' OR m.body LIKE '%https://%.jpg%' OR m.body LIKE '%https://%.jpeg%' OR m.body LIKE '%https://%.gif%' OR m.body LIKE '%https://%.webp%')`;
    else if (h === 'video') where += ` AND m.attachments LIKE '%"type":"video"%'`;
    else if (h === 'sound' || h === 'audio') where += ` AND m.attachments LIKE '%"type":"audio"%'`;
    else if (h === 'file') where += ' AND m.attachments IS NOT NULL';
    else if (h === 'link') where += " AND m.body LIKE '%http%'";
    else if (h === 'embed') where += ' AND m.embeds IS NOT NULL';
  }
  const off = Math.max(0, Math.min(Number(offset) || 0, 500));
  const from_ = ' FROM messages m LEFT JOIN users u ON u.id = m.user_id';
  const rows = db.raw().prepare(`${SELECT_MSG} WHERE ${where} ORDER BY m.id DESC LIMIT ${per} OFFSET ${off}`).all(...params);
  const total = db.raw().prepare(`SELECT COUNT(*) AS n${from_} WHERE ${where}`).get(...params).n;
  return { messages: rows.map(r => ({ ...messageView(r, snap), channel_name: snap.channels.find(c => c.id === r.channel_id)?.name })), total };
}
function pinMessage(id, me, on) {
  const { r, ch, c, snap } = messageCtx(id, me);
  if (!snap.can(me.id, P.MANAGE_MESSAGES)) throw err('not_allowed', 403);
  if (r.system) throw err('not_allowed', 403);
  if (on && !r.pinned_at) {
    if (db.get('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL', ch.id).n >= MAX_PINS) throw err('too_many_pins');
    db.run('UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ?', Date.now(), me.id, r.id);
  } else if (!on && r.pinned_at) db.run('UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?', r.id);
  else return;
  const author = r.user_id ? auth.userById(r.user_id) : null;
  audit().record(c, me, on ? 'message_pin' : 'message_unpin', { target: { kind: 'message', id: r.id, name: author?.username || r.author_name || null }, details: { channel: ch.name } });
  gateway.emit(c.id, { type: 'chat_message_update', message: viewById(r.id, snap) });
  gateway.emit(c.id, { type: 'chat_pins_update', server: c.sid, channel: ch.cid });
  if (on) systemMessage({ ch, c, snap }, `@${me.username} pinned a message to this channel.`, { sysKind: 'pin', replyTo: r.id, subjectId: me.id, subjectParts: [null, ' pinned a message to this channel.'] });
}
function pins(cid, me) {
  const { ch, snap } = C.findChannel(cid, me);
  const rows = db.all(`${SELECT_MSG} WHERE m.channel_id = ? AND m.pinned_at IS NOT NULL ORDER BY m.pinned_at DESC LIMIT ${MAX_PINS}`, ch.id);
  return { messages: attachVia(rows, snap, me, withReactions(rows.map(r => messageView(r, snap)))) };
}
function markRead(cid, me, id) {
  const { ch } = C.findChannel(cid, me);
  const fresh = db.get('SELECT last_message_id FROM channels WHERE id = ?', ch.id).last_message_id;
  const upto = Math.min(Number(id) || Number(fresh), Number(fresh));
  db.run('INSERT INTO read_state (user_id, channel_id, last_read_id) VALUES (?, ?, ?) ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)', me.id, ch.id, upto);
}

module.exports = {
  viaOf, MSG_MAX, SELECT_MSG, messageView, viewById, reactionsFor, withReactions, cleanAttachments, postMessage, systemMessage, insertMessage, editMessage, deleteMessage,
  react, history, search, searchServer, pinMessage, pins, markRead, checkSignature,
  onPost, onEdit, onDelete, postBridged, editBridged, deleteBridged, postWebhook, ctxOf, _sendLimit: sendLimit,
};
