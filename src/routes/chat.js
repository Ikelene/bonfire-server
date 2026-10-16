'use strict';
// Community REST API: same paths + response shapes as Velora's routes/chat.js under /api/v1 (PROTOCOL §6).
const C = require('../communities');
const uploads = require('../uploads');
const { err } = require('../util');

const IMG_MAX = 4 * 1024 * 1024;

function register(app) {
  const v1 = p => '/api/v1' + p;
  const A = { auth: false };

  // an invite link's community (name, icon, member count): no login needed, so invite pages can show it
  app.get(v1('/invite/:code'), A, req => ({ server: C.inviteInfo(req.params.code) }));

  app.get(v1('/identities'), req => C.identities(req.query.ids));
  app.get(v1('/settings'), req => ({ settings: C.getSettings(req.user), defaults: C.SETTING_DEFAULTS }));
  app.patch(v1('/settings'), req => ({ settings: C.setSettings(req.user, req.body) }));
  app.get(v1('/notify'), req => ({ notify: C.notifyList(req.user) }));
  app.put(v1('/notify/:target'), req => ({ notify: C.setNotify(req.user, req.params.target, req.body || {}) }));

  // ---- servers ----
  app.get(v1('/servers'), req => ({ servers: C.myServers(req.user) }));
  app.get(v1('/discover'), req => ({ servers: C.discover(req.user) }));
  app.post(v1('/servers'), req => { const c = C.createCommunity(req.user, req.body || {}); return C.serverDetail(c.sid, req.user); });
  app.get(v1('/servers/:sid'), req => C.serverDetail(req.params.sid, req.user));
  app.patch(v1('/servers/:sid'), req => ({ server: C.updateServer(req.params.sid, req.user, { ...(req.body || {}), new_invite: !!req.body?.new_invite }) }));
  app.put(v1('/servers/:sid/layout'), req => C.setLayout(req.params.sid, req.user, {
    categories: Array.isArray(req.body?.categories) ? req.body.categories : undefined,
    channels: Array.isArray(req.body?.channels) ? req.body.channels.map(c => ({ cid: c?.cid, category: c?.category })) : undefined,
  }));
  app.delete(v1('/servers/:sid'), req => { C.deleteCommunity(req.params.sid, req.user); });
  app.post(v1('/servers/:sid/join'), req => C.joinServer(req.params.sid, req.user, null, req.body));
  app.post(v1('/join/:code'), req => C.joinServer(null, req.user, req.params.code));
  app.post(v1('/servers/:sid/leave'), req => { C.leaveServer(req.params.sid, req.user); });

  // server icon / banner (Manage server)
  const image = kind => async req => {
    const { snap, c } = C.memberCommunity(req.params.sid, req.user);
    if (!snap.can(req.user.id, require('../perms').P.MANAGE_SERVER)) throw err('not_allowed', 403);
    const { buffer } = await uploads.readMultipart(req, { maxBytes: IMG_MAX });
    if (!buffer) throw err('no_file');
    return { server: C.updateServer(c.sid, req.user, kind === 'icon' ? { icon_url: uploads.saveImage(buffer, 'icon') } : { banner_url: uploads.saveImage(buffer, 'banner') }) };
  };
  app.post(v1('/servers/:sid/icon'), image('icon'));
  app.post(v1('/servers/:sid/banner'), image('banner'));
  app.delete(v1('/servers/:sid/icon'), req => ({ server: C.updateServer(req.params.sid, req.user, { icon_url: null }) }));
  app.delete(v1('/servers/:sid/banner'), req => ({ server: C.updateServer(req.params.sid, req.user, { banner_url: null }) }));

  // ---- members ----
  app.get(v1('/servers/:sid/members'), req => C.memberList(req.params.sid, req.user));
  app.delete(v1('/servers/:sid/members/:uid'), req => { C.moderateMember(req.params.sid, req.user, req.params.uid, req.query.ban === '1' ? 'ban' : 'kick'); });
  app.get(v1('/servers/:sid/bans'), req => C.banList(req.params.sid, req.user));
  app.delete(v1('/servers/:sid/bans/:uid'), req => { C.moderateMember(req.params.sid, req.user, req.params.uid, 'unban'); });

  // ---- join requests + invites ----
  app.get(v1('/servers/:sid/requests'), req => C.listRequests(req.params.sid, req.user));
  app.post(v1('/servers/:sid/requests/:uid/accept'), req => { C.resolveRequest(req.params.sid, req.user, req.params.uid, true); });
  app.post(v1('/servers/:sid/requests/:uid/deny'), req => { C.resolveRequest(req.params.sid, req.user, req.params.uid, false); });
  app.get(v1('/servers/:sid/invites'), req => C.listInvites(req.params.sid, req.user));
  app.post(v1('/servers/:sid/invites'), req => C.createInvite(req.params.sid, req.user, req.body));
  app.delete(v1('/invites/:code'), req => { C.deleteInvite(req.params.code, req.user); });

  // ---- roles ----
  app.post(v1('/servers/:sid/roles'), req => ({ role: C.createRole(req.params.sid, req.user, req.body) }));
  app.put(v1('/servers/:sid/roles/order'), req => ({ roles: C.orderRoles(req.params.sid, req.user, req.body?.order) }));
  app.patch(v1('/servers/:sid/roles/:rid'), req => ({ role: C.updateRole(req.params.sid, req.user, req.params.rid, req.body) }));
  app.delete(v1('/servers/:sid/roles/:rid'), req => { C.deleteRole(req.params.sid, req.user, req.params.rid); });
  app.put(v1('/servers/:sid/members/:uid/roles/:rid'), req => { C.setMemberRole(req.params.sid, req.user, req.params.uid, req.params.rid, true); });
  app.delete(v1('/servers/:sid/members/:uid/roles/:rid'), req => { C.setMemberRole(req.params.sid, req.user, req.params.uid, req.params.rid, false); });
  app.post(v1('/servers/:sid/roles/:rid/icon'), async req => {
    C.memberCommunity(req.params.sid, req.user);
    const { buffer } = await uploads.readMultipart(req, { maxBytes: IMG_MAX });
    if (!buffer) throw err('no_file');
    return { role: C.setRoleIcon(req.params.sid, req.user, req.params.rid, uploads.saveImage(buffer, 'role')) };
  });
  app.delete(v1('/servers/:sid/roles/:rid/icon'), req => ({ role: C.setRoleIcon(req.params.sid, req.user, req.params.rid, null) }));

  // ---- channels ----
  app.post(v1('/servers/:sid/channels'), req => ({ channel: C.createChannel(req.params.sid, req.user, req.body) }));
  app.patch(v1('/channels/:cid'), req => ({ channel: C.updateChannel(req.params.cid, req.user, req.body) }));
  app.delete(v1('/channels/:cid'), req => { C.deleteChannel(req.params.cid, req.user); });
  app.put(v1('/channels/:cid/perms'), req => ({ channel: C.setChannelPerms(req.params.cid, req.user, req.body?.overwrites) }));
  app.post(v1('/channels/:cid/icon'), async req => {
    C.findChannel(req.params.cid, req.user);
    const { buffer } = await uploads.readMultipart(req, { maxBytes: IMG_MAX });
    if (!buffer) throw err('no_file');
    return { channel: C.updateChannel(req.params.cid, req.user, { icon: uploads.saveImage(buffer, 'channel') }) };
  });

  // ---- emojis ----
  app.get(v1('/emojis'), req => C.allEmojis(req.user));
  app.get(v1('/servers/:sid/emojis'), req => C.listEmojis(req.params.sid, req.user));
  app.post(v1('/servers/:sid/emojis'), async req => {
    C.memberCommunity(req.params.sid, req.user);
    const { buffer, filename, fields } = await uploads.readMultipart(req, { maxBytes: 2 * 1024 * 1024 });
    return C.createEmoji(req.params.sid, req.user, { buffer, name: fields.name, filename });
  });
  app.patch(v1('/servers/:sid/emojis/:eid'), req => { C.renameEmoji(req.params.sid, req.user, req.params.eid, req.body?.name); });
  app.delete(v1('/servers/:sid/emojis/:eid'), req => { C.deleteEmoji(req.params.sid, req.user, req.params.eid); });
}
module.exports = { register };
