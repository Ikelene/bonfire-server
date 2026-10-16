'use strict';
// Bot REST API, Discord's dialect: INSTANCE/bot/v1/... with "Authorization: Bot <token>" (PROTOCOL §13). Velora serves the same
// API at /chat/api/v1; here the prefix is /bot/v1 and the gateway is /bot/gateway. See bots.js for ids and events.
const db = require('../db');
const C = require('../communities');
const M = require('../messages');
const B = require('../bots');
const uploads = require('../uploads');
const W = require('../webhooks');
const { err, limiter } = require('../util');

const ERR = {
  not_a_member: [403, 50001, 'Missing Access'], channel_not_found: [404, 10003, 'Unknown Channel'], message_not_found: [404, 10008, 'Unknown Message'],
  server_not_found: [404, 10004, 'Unknown Guild'], user_not_found: [404, 10013, 'Unknown User'], not_allowed: [403, 50013, 'Missing Permissions'],
  no_send_permission: [403, 50013, 'Missing Permissions'], no_attach_permission: [403, 50013, 'Missing Permissions'], channel_locked: [403, 50013, 'Missing Permissions'],
  empty_message: [400, 50006, 'Cannot send an empty message'], rate_limited: [429, 0, 'You are being rate limited.'], cannot_dm_bot: [403, 50007, 'Cannot send messages to this user'],
};
const hits = limiter(150, 10000); // per bot

function register(app) {
  const V = p => '/bot/v1' + p;
  const route = fn => async (req, res) => {
    try {
      const bot = B.fromHeader(req.headers.authorization);
      if (!bot) return app.send(res, 401, { message: '401: Unauthorized', code: 0 });
      if (!hits.hit(bot.id)) return app.send(res, 429, { message: 'You are being rate limited.', retry_after: 2, global: false, code: 0 });
      const out = await fn(req, bot, res);
      if (res.headersSent) return;
      if (out === undefined) { res.writeHead(204); return res.end(); }
      app.send(res, 200, out);
    } catch (e) {
      if (res.headersSent) return;
      const [status, code, message] = ERR[e.code] || [e.status || (e.code ? 400 : 500), 0, e.code || 'Server error'];
      if (!e.code) console.error('[bot api]', req.method, req.url, e.stack || e.message);
      app.send(res, status, { message, code, ...(status === 429 ? { retry_after: 1, global: false } : {}) });
    }
  };
  const get = (p, fn) => app.get(V(p), { auth: false }, route(fn));
  const post = (p, fn) => app.post(V(p), { auth: false }, route(fn));
  const patch = (p, fn) => app.patch(V(p), { auth: false }, route(fn));
  const put = (p, fn) => app.put(V(p), { auth: false }, route(fn));
  const del = (p, fn) => app.delete(V(p), { auth: false }, route(fn));

  // discovery (same shape as Fluxer's /.well-known/fluxer) + gateway info: no token needed
  const disc = () => ({ api_code_version: 1, endpoints: { api: B.apiUrl(), api_public: B.apiUrl(), api_client: B.apiUrl(), gateway: B.gatewayUrl() } });
  app.get('/bot/discovery', { auth: false }, disc);
  app.get(V('/gateway'), { auth: false }, () => ({ url: B.gatewayUrl() }));

  // ids are row ids: a community ("guild"), channel, message and user is its number
  const guild = (bot, gid) => {
    const c = db.get('SELECT * FROM communities WHERE id = ?', Number(gid));
    if (!c) throw err('server_not_found', 404);
    const snap = C.snapOf(c);
    if (!snap.isMember(bot.id)) throw err('not_a_member', 403);
    return { c, snap };
  };
  const channel = (bot, id) => {
    const row = db.get('SELECT cid FROM channels WHERE id = ?', Number(id));
    if (!row) throw err('channel_not_found', 404);
    return C.findChannel(row.cid, bot); // not a member -> 403, can't see it -> 404
  };
  const inChannel = (ctx, mid) => { const r = /^\d{1,15}$/.test(String(mid)) && db.get('SELECT id FROM messages WHERE id = ? AND channel_id = ?', Number(mid), ctx.ch.id); if (!r) throw err('message_not_found', 404); return r.id; };
  const full = (ctx, id) => M.withReactions([M.viewById(id, ctx.snap)])[0];
  const member = (c, snap, u) => ({ user: B.userObj(u), nick: null, roles: [...snap.roleIds(u.id)].map(id => String(B.ROLE_BASE + id)), joined_at: new Date(db.get('SELECT joined_at FROM members WHERE community_id = ? AND user_id = ?', c.id, u.id).joined_at).toISOString(), deaf: false, mute: false });

  get('/gateway/bot', () => ({ url: B.gatewayUrl(), shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 } }));
  get('/users/@me', (req, bot) => B.userObj(bot));
  get('/oauth2/applications/@me', (req, bot) => ({ id: String(bot.id), name: bot.username, bot: B.userObj(bot), bot_public: true }));
  get('/users/@me/guilds', (req, bot) => db.all('SELECT c.* FROM communities c JOIN members m ON m.community_id = c.id WHERE m.user_id = ? ORDER BY c.id', bot.id)
    .map(c => ({ id: String(c.id), name: c.name, icon: c.icon_url ? 'bonfire' : null, icon_url: c.icon_url || null, owner: false })));
  del('/users/@me/guilds/:gid', (req, bot) => { C.removeMember(guild(bot, req.params.gid).c, bot.id, 'left'); });
  post('/users/@me/channels', () => { throw err('cannot_dm_bot', 403); }); // no DMs for bots
  get('/users/:uid', req => {
    const u = /^\d{1,15}$/.test(req.params.uid) && auth().userById(Number(req.params.uid));
    if (!u) throw err('user_not_found', 404);
    return B.userObj(u);
  });

  get('/guilds/:gid', (req, bot) => { const { c, snap } = guild(bot, req.params.gid); return B.guildObj(c, snap, false, bot); });
  get('/guilds/:gid/roles', (req, bot) => { const { c, snap } = guild(bot, req.params.gid); return snap.roles.map(r => B.roleObj(c, r)); });
  get('/guilds/:gid/channels', (req, bot) => { const { c, snap } = guild(bot, req.params.gid); return snap.visible(bot.id).map(ch => B.channelObj(ch, c)); });
  get('/guilds/:gid/members/:uid', (req, bot) => {
    const { c, snap } = guild(bot, req.params.gid);
    const u = /^\d{1,15}$/.test(req.params.uid) && auth().userById(Number(req.params.uid));
    if (!u || !snap.isMember(u.id)) throw err('user_not_found', 404);
    return member(c, snap, u);
  });
  get('/guilds/:gid/members', (req, bot) => {
    const { c, snap } = guild(bot, req.params.gid);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
    return db.all('SELECT u.* FROM users u JOIN members m ON m.user_id = u.id WHERE m.community_id = ? ORDER BY u.id LIMIT ?', c.id, limit).map(u => member(c, snap, u));
  });

  get('/channels/:cid', (req, bot) => { const x = channel(bot, req.params.cid); return B.channelObj(x.ch, x.c); });
  post('/channels/:cid/typing', (req, bot) => {
    const { ch, c } = channel(bot, req.params.cid);
    require('../gateway').emit(c.id, { type: 'chat_typing', server: c.sid, channel: ch.cid, username: bot.username, user_id: bot.principal, typing: true });
  });
  get('/channels/:cid/messages', (req, bot) => {
    const ctx = channel(bot, req.params.cid);
    const h = M.history(ctx.ch.cid, bot, { before: req.query.before, after: req.query.after, limit: req.query.limit });
    return h.messages.map(m => B.messageObj(m, ctx.c, ctx.snap)).reverse(); // newest first, like Discord
  });
  get('/channels/:cid/messages/:mid', (req, bot) => { const ctx = channel(bot, req.params.cid); return B.messageObj(full(ctx, inChannel(ctx, req.params.mid)), ctx.c, ctx.snap); });
  post('/channels/:cid/messages', async (req, bot) => {
    const ctx = channel(bot, req.params.cid);
    let body = req.body || {}, files = [];
    if (/^multipart\//i.test(req.headers['content-type'] || '')) { const f = await uploads.readForm(req); body = f.fields; files = f.files; }
    if (body.payload_json != null) { try { body = JSON.parse(body.payload_json); } catch { throw err('empty_message'); } }
    const text = B.textIn(ctx.c, ctx.snap, body.content, body.allowed_mentions);
    const fl = W.withFiles(files, body.embeds, bot.id);
    const msg = await M.postMessage(bot, ctx, text, { replyTo: body.message_reference?.message_id || null, attachments: fl.atts, embeds: W.cleanEmbeds(fl.embeds) });
    return B.messageObj(msg, ctx.c, ctx.snap);
  });
  patch('/channels/:cid/messages/:mid', async (req, bot) => {
    const ctx = channel(bot, req.params.cid);
    const msg = await M.editMessage(inChannel(ctx, req.params.mid), bot, B.textIn(ctx.c, ctx.snap, req.body?.content, req.body?.allowed_mentions));
    return B.messageObj(msg, ctx.c, ctx.snap);
  });
  del('/channels/:cid/messages/:mid', (req, bot) => { const ctx = channel(bot, req.params.cid); M.deleteMessage(inChannel(ctx, req.params.mid), bot); });
  // reactions: :emoji is the character, or name:eid for a custom one
  put('/channels/:cid/messages/:mid/reactions/:emoji/@me', (req, bot) => { const ctx = channel(bot, req.params.cid); M.react(inChannel(ctx, req.params.mid), bot, req.params.emoji, true); });
  del('/channels/:cid/messages/:mid/reactions/:emoji/@me', (req, bot) => { const ctx = channel(bot, req.params.cid); M.react(inChannel(ctx, req.params.mid), bot, req.params.emoji, false); });
  put('/channels/:cid/pins/:mid', (req, bot) => { const ctx = channel(bot, req.params.cid); M.pinMessage(inChannel(ctx, req.params.mid), bot, true); });
  del('/channels/:cid/pins/:mid', (req, bot) => { const ctx = channel(bot, req.params.cid); M.pinMessage(inChannel(ctx, req.params.mid), bot, false); });
}
const auth = () => require('../auth');
module.exports = { register, _hits: hits };
