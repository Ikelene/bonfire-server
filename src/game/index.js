'use strict';
// Bonfire Link (Minecraft) on the instance: REST under /api/v1/game/* (same shapes as Velora's /chat/game/*), the game
// gateway at /game-gateway, hooks into messages / channel changes, hourly retention. PROTOCOL §18.
const G = require('./game');
const GW = require('./gateway');
const C = require('../communities');
const db = require('../db');
const { P } = require('../perms');
const { err, limiter } = require('../util');

const unclaimedLimit = limiter(30, 60000);
const execLimit = limiter(10, 10000);
let purgeTimer = null, unhook = [];

function init() {
  G.ensure();
  GW.start();
  const M = require('../messages');
  unhook.forEach(f => f());
  unhook = [M.onPost(G.onPost), C.onChannelsChanged(c => G.channelsChanged(c))];
  clearInterval(purgeTimer);
  purgeTimer = setInterval(() => { try { G.purge(); } catch (e) { console.error('[game] purge', e.message); } }, 3600e3);
  purgeTimer.unref();
  try { G.purge(); } catch (e) { console.error('[game] purge', e.message); }
}
function shutdown() {
  clearInterval(purgeTimer);
  unhook.forEach(f => f()); unhook = [];
  GW.shutdown();
}

// a community you're in + a permission there. sid is optional: an instance has one community (PROTOCOL §5a)
function communityWith(sid, me, bit) {
  const s = sid || db.get('SELECT sid FROM communities ORDER BY id LIMIT 1')?.sid;
  if (!s) throw err('server_not_found', 404);
  const r = C.memberCommunity(s, me);
  if (!r.snap.can(me.id, bit)) throw err('not_allowed', 403);
  return r;
}
// a game channel you can see (console channels are Manage server only through canView)
function gameChannel(cid, me) {
  const r = C.findChannel(cid, me);
  if (r.ch.type !== 'game') throw err('not_a_game_channel', 400);
  return r;
}
const meOf = req => ({ ...req.user, pfp: req.user.pfp || null });

function register(app) {
  const v1 = p => '/api/v1/game' + p;

  // the plugin / mod downloads (public). The instance doesn't host builds: it points at the official ones.
  app.get(v1('/downloads'), { auth: false }, () => ({ version: null, modrinth_url: '', files: {} }));

  // linked game servers of the community (Manage channels: the setup screen picks from these)
  app.get(v1('/servers/:sid/instances'), req => { const { c } = communityWith(req.params.sid, req.user, P.MANAGE_CHANNELS); return { instances: G.communityInstances(c.id) }; });
  app.delete(v1('/servers/:sid/instances/:iid'), req => {
    const { c } = communityWith(req.params.sid, req.user, P.MANAGE_SERVER);
    const link = G.linkOfIid(String(req.params.iid));
    if (!link || link.community_id !== c.id) throw err('not_linked', 404);
    return G.unlink(String(req.params.iid), 'bonfire', req.user);
  });
  // "Connected game servers": every unclaimed game server connected to this instance right now (Manage server).
  // /unclaimed is Velora's name for the same list.
  const listConnected = req => {
    if (!unclaimedLimit.hit(req.user.id)) throw err('rate_limited', 429);
    communityWith(req.query.sid, req.user, P.MANAGE_SERVER);
    return GW.unclaimed({ tag: String(req.query.tag || '').slice(0, 12), q: String(req.query.q || '').slice(0, 60), page: req.query.page });
  };
  app.get(v1('/unclaimed'), listConnected);
  app.get(v1('/connected'), listConnected);
  // pick one from the list: link it to this community (and to the game channel `cid` when that one has no server yet)
  app.post(v1('/connected/:iid/link'), req => {
    const { c } = communityWith(req.body?.sid, req.user, P.MANAGE_SERVER);
    let cid = null;
    if (req.body?.cid) {
      const { ch } = C.findChannel(String(req.body.cid), req.user);
      if (ch.community_id !== c.id || ch.type !== 'game') throw err('not_a_game_channel');
      cid = ch.cid;
    }
    return GW.linkConnected(c, meOf(req), String(req.params.iid), cid);
  });
  // a claim code: run `bonfire link CODE` in the server console (Manage server; cid = the game channel it's for)
  app.post(v1('/claims'), req => {
    const { c } = communityWith(req.body?.sid, req.user, P.MANAGE_SERVER);
    let cid = null;
    if (req.body?.cid) {
      const { ch } = C.findChannel(String(req.body.cid), req.user);
      if (ch.community_id !== c.id || ch.type !== 'game') throw err('not_a_game_channel');
      cid = ch.cid;
    }
    if (G.linksOf(c.id).length >= G.MAX_LINKS) throw err('too_many_instances');
    const hint = /^g[0-9a-f]{16}$/.test(String(req.body?.hint || '')) ? String(req.body.hint) : null;
    return GW.createClaim({ c, user: req.user, cid, hint });
  });
  app.get(v1('/claims/:code'), req => GW.claimState(req.params.code, req.user));

  // the live card: instance + last status
  app.get(v1('/channels/:cid/status'), req => {
    const { ch } = gameChannel(req.params.cid, req.user);
    const iid = G.cfgOf(ch).instance;
    if (!iid) return { instance: null, status: null, online: false, last_seen: null };
    const l = GW.liveOf(iid);
    return { instance: G.instanceView(G.instanceRow(iid)), status: G.statusForChannel(ch, iid), online: !!l.online, last_seen: l.last_seen || null, connected: GW.isConnected(iid), features: GW.sessionOf(iid)?.features || null };
  });
  // console lines (ring buffer, newest 200 per page)
  app.get(v1('/channels/:cid/console'), req => {
    const { ch } = gameChannel(req.params.cid, req.user);
    const cfg = G.cfgOf(ch);
    if (cfg.purpose !== 'console' || !cfg.instance) throw err('not_a_console', 400);
    return GW.consoleLines(cfg.instance, { before: req.query.before });
  });
  // run a command (Manage server). Every command lands in the audit log.
  app.post(v1('/channels/:cid/console'), async req => {
    const { ch, snap } = gameChannel(req.params.cid, req.user);
    const cfg = G.cfgOf(ch);
    if (cfg.purpose !== 'console' || !cfg.instance) throw err('not_a_console', 400);
    if (!snap.can(req.user.id, P.MANAGE_SERVER)) throw err('not_allowed', 403);
    if (!req.scopes.includes('chat')) throw err('insufficient_scope', 403);
    if (!execLimit.hit(req.user.id)) throw err('rate_limited', 429);
    const command = String(req.body?.command ?? '').replace(/[\r\n]+/g, ' ').trim().replace(/^\/+/, '').slice(0, 1000);
    if (!command) throw err('empty_command');
    return GW.exec(cfg.instance, command, meOf(req), ch.community_id);
  });
  // the audit log (Manage server): links, unlinks and every command with who ran it
  app.get(v1('/servers/:sid/audit'), req => { const { c } = communityWith(req.params.sid, req.user, P.MANAGE_SERVER); return G.auditList(c.id, req.query.before); });
}

module.exports = { init, shutdown, register, handleUpgrade: GW.handleUpgrade, game: G, gateway: GW };
