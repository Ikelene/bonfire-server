'use strict';
// External bridges: Discord / Fluxer (bridge.js) and CloudLink (cloudlink.js). index.js calls init() at boot and
// register(app) for the routes (PROTOCOL §16, §17); communities.channelView reads channelTag().
const bridge = require('./bridge');
const cloudlink = require('./cloudlink');
const store = require('./store');

function init() {
  store.ensure();
  bridge.init();
  cloudlink.init();
}
function shutdown() {
  bridge.shutdown();
  cloudlink.shutdown();
}

function register(app) {
  const v1 = p => '/api/v1' + p;
  const s = v => String(v ?? '');

  // ---- instance settings: the owner's bot tokens (admins; tokens are write-only) ----
  app.get(v1('/bridge/settings'), { admin: true }, () => ({ bridges: bridge.settingsView() }));
  app.patch(v1('/bridge/settings'), { admin: true }, async req => ({ bridges: await bridge.saveSettings(req.body || {}) }));

  // ---- Discord / Fluxer (same shapes as Velora's /chat/bridge/*; Manage server) ----
  app.get(v1('/bridge/platforms'), () => bridge.platforms());
  app.get(v1('/bridge/:platform/guilds'), req => bridge.guilds(req.user, req.params.platform));
  app.get(v1('/bridge/servers/:sid'), req => bridge.status(req.user, req.params.sid));
  app.put(v1('/bridge/servers/:sid'), req => bridge.link(req.user, req.params.sid, s(req.body?.platform), s(req.body?.guild_id), req.body?.automap !== false));
  app.patch(v1('/bridge/servers/:sid'), req => bridge.setEnabled(req.user, req.params.sid, s(req.body?.platform), !!req.body?.enabled));
  app.delete(v1('/bridge/servers/:sid'), req => bridge.unlink(req.user, req.params.sid, s(req.body?.platform || req.query.platform)));
  app.put(v1('/bridge/servers/:sid/channels/:cid'), req => bridge.setChannel(req.user, req.params.sid, req.params.cid, s(req.body?.platform), req.body?.ext_channel_id ? s(req.body.ext_channel_id) : null));

  // ---- CloudLink bridge channels: connection status + reconnect (Manage channels) ----
  app.get(v1('/channels/:cid/cloudlink'), req => ({ status: cloudlink.status(cloudlink.bridgeChannel(req.params.cid, req.user)) }));
  app.post(v1('/channels/:cid/cloudlink/reconnect'), req => ({ status: cloudlink.reconnect(cloudlink.bridgeChannel(req.params.cid, req.user)) }));
}

const channelTag = channelId => bridge.channelTag(channelId);
const features = () => { const PL = require('./platform'); return { discord: !!PL.tokenOf('discord'), fluxer: !!PL.tokenOf('fluxer'), cloudlink: true }; };

module.exports = { init, shutdown, register, channelTag, features, bridge, cloudlink };
