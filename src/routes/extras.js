'use strict';
// Community features beyond core chat: roles shop, starboard, webhook management, soundboard, link previews, bot management,
// emoji info, YouTube player. Same paths and shapes as Velora's routes/chat.js under /api/v1 (PROTOCOL §6).
const C = require('../communities');
const uploads = require('../uploads');
const starboard = require('../starboard');
const webhooks = require('../webhooks');
const soundboard = require('../soundboard');
const unfurl = require('../unfurl');
const bots = require('../bots');
const youtube = require('../youtube');
const { err, limiter } = require('../util');

const IMG_MAX = 4 * 1024 * 1024;
const unfurlLimit = limiter(60, 60 * 1000);

function register(app) {
  const v1 = p => '/api/v1' + p;
  const scope = (req, s) => { if (!req.scopes.includes(s)) throw err('insufficient_scope', 403); };

  app.get(v1('/emojis/:eid/info'), req => C.emojiInfo(req.params.eid, req.user));

  // ---- roles shop ----
  app.get(v1('/channels/:cid/shop'), req => C.shopView(req.params.cid, req.user));
  app.post(v1('/channels/:cid/shop/:rid'), req => C.shopRole(req.params.cid, req.user, req.params.rid, true));
  app.delete(v1('/channels/:cid/shop/:rid'), req => C.shopRole(req.params.cid, req.user, req.params.rid, false));

  // ---- starboard ----
  app.get(v1('/channels/:cid/starboard'), req => starboard.view(req.params.cid, req.user, { before: req.query.before }));

  // ---- webhooks (posting is /api/v1/webhooks/:wid/:token, routes/hooks.js) ----
  app.get(v1('/channels/:cid/webhooks'), req => ({ webhooks: webhooks.list(req.params.cid, req.user) }));
  app.post(v1('/channels/:cid/webhooks'), req => ({ webhook: webhooks.create(req.params.cid, req.user, req.body) }));
  app.patch(v1('/hooks/:wid'), req => ({ webhook: webhooks.update(req.params.wid, req.user, req.body) }));
  app.delete(v1('/hooks/:wid'), req => { webhooks.remove(req.params.wid, req.user); });
  app.post(v1('/hooks/:wid/avatar'), async req => {
    const { buffer } = await uploads.readMultipart(req, { maxBytes: IMG_MAX });
    return { webhook: await webhooks.setAvatar(req.params.wid, req.user, buffer) };
  });

  // ---- soundboard ----
  app.get(v1('/sounds'), req => soundboard.mine(req.user));
  app.get(v1('/servers/:sid/sounds'), req => soundboard.list(req.params.sid, req.user));
  app.post(v1('/servers/:sid/sounds'), async req => {
    C.memberCommunity(req.params.sid, req.user);
    const { buffer, filename, fields } = await uploads.readMultipart(req, { maxBytes: 8 * 1024 * 1024 });
    return soundboard.add(req.params.sid, req.user, { buffer, filename }, fields);
  });
  app.patch(v1('/servers/:sid/sounds/:id'), req => soundboard.update(req.params.sid, req.user, req.params.id, req.body));
  app.delete(v1('/servers/:sid/sounds/:id'), req => { soundboard.remove(req.params.sid, req.user, req.params.id); });

  // ---- link previews: the instance fetches the page, never the browser (needs a session) ----
  app.get(v1('/unfurl'), async req => {
    if (!unfurlLimit.hit(req.user.id)) throw err('rate_limited', 429);
    return { embed: await unfurl.unfurl(String(req.query.url || '')) };
  });

  // ---- bot accounts: managed by people with Manage server (and instance admins) ----
  app.get(v1('/bots'), req => bots.mine(req.user));
  app.post(v1('/bots'), req => bots.create(req.user, req.body));
  app.get(v1('/bots/by-name/:username'), req => bots.info(req.user, req.params.username));
  app.post(v1('/bots/by-name/:username/add'), req => { bots.addToServer(req.user, req.params.username, String(req.body?.sid || '')); });
  app.patch(v1('/bots/:id'), req => bots.update(req.user, req.params.id, req.body));
  app.post(v1('/bots/:id/avatar'), async req => {
    const { buffer } = await uploads.readMultipart(req, { maxBytes: IMG_MAX });
    return bots.setAvatar(req.user, req.params.id, buffer);
  });
  app.post(v1('/bots/:id/token'), req => bots.resetToken(req.user, req.params.id));
  app.delete(v1('/bots/:id'), req => { bots.remove(req.user, req.params.id); });

  // ---- YouTube player (optional, needs yt-dlp; PROTOCOL §14) ----
  app.get(v1('/yt/stream/:id'), { auth: false }, (req, res) => youtube.stream(req, res)); // signed link instead of a session
  app.post(v1('/yt/:id/prepare'), req => { scope(req, 'chat'); return youtube.prepare(req.params.id); });
  app.get(v1('/yt/:id/status'), req => { scope(req, 'chat'); return youtube.status(req.params.id); });
  app.post(v1('/yt/:id/save'), req => { scope(req, 'chat'); scope(req, 'media'); return youtube.save(req.params.id, req.user, req.body?.title); });
}
module.exports = { register };
