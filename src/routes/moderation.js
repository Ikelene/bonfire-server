'use strict';
// Server settings (joining, message rules, AutoMod, audit log, uploads), reports, timeouts, the audit log and the dashboard (PROTOCOL §6.4).
const C = require('../communities');
const S = require('../settings');
const mod = require('../moderation');
const audit = require('../audit');
const gateway = require('../gateway');
const { P } = require('../perms');
const { err } = require('../util');

function register(app) {
  const v1 = p => '/api/v1' + p;
  const manager = (req) => {
    const r = C.memberCommunity(req.params.sid, req.user);
    if (!r.snap.can(req.user.id, P.MANAGE_SERVER)) throw err('not_allowed', 403);
    return r;
  };

  // ---- settings ----
  app.get(v1('/servers/:sid/settings'), req => { const { c } = manager(req); return { settings: S.view(c, req.user) }; });
  app.patch(v1('/servers/:sid/settings'), async req => {
    const { c, snap } = manager(req);
    const { changed } = await S.update(c, snap, req.user, req.body || {});
    if (changed.length) {
      gateway.emit(c.id, { type: 'chat_server_update', server: C.serverView(c, C.snapOf(c), null) });
      audit.record(c, req.user, 'settings_update', { details: { changed } });
    }
    return { settings: S.view(c, req.user) };
  });

  // ---- reports ----
  app.post(v1('/servers/:sid/reports'), req => mod.createReport(req.params.sid, req.user, req.body || {}));
  app.get(v1('/servers/:sid/reports'), req => mod.listReports(req.params.sid, req.user, { status: req.query.status, before: req.query.before }));
  app.patch(v1('/servers/:sid/reports/:id'), req => mod.setReportStatus(req.params.sid, req.user, req.params.id, req.body || {}));

  // ---- timeouts (AutoMod and moderators set them; moderators can lift them) ----
  app.get(v1('/servers/:sid/timeouts'), req => mod.listTimeouts(req.params.sid, req.user));
  app.post(v1('/servers/:sid/timeouts'), req => mod.timeOutBy(req.params.sid, req.user, req.body || {}));
  app.delete(v1('/servers/:sid/timeouts/:uid'), req => { mod.liftTimeout(req.params.sid, req.user, req.params.uid); });

  // ---- audit log (Manage server, Kick or Ban) ----
  app.get(v1('/servers/:sid/audit'), req => {
    const { c, snap } = C.memberCommunity(req.params.sid, req.user);
    if (!snap.can(req.user.id, P.MANAGE_SERVER) && !snap.can(req.user.id, P.KICK) && !snap.can(req.user.id, P.BAN)) throw err('not_allowed', 403);
    return audit.list(c, req.query);
  });

  // ---- dashboard (Server settings > Dashboard) ----
  app.get(v1('/servers/:sid/dashboard'), req => { const { c } = manager(req); return require('../dashboard').view(c); });
}
module.exports = { register };
