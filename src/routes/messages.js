'use strict';
// Messages, uploads, export / import.
const config = require('../config');
const C = require('../communities');
const M = require('../messages');
const uploads = require('../uploads');
const exp = require('../export');
const { err } = require('../util');

function register(app) {
  const v1 = p => '/api/v1' + p;

  app.get(v1('/channels/:cid/messages'), req => M.history(req.params.cid, req.user, req.query));
  app.post(v1('/channels/:cid/messages'), async req => ({
    message: await M.postMessage(req.user, C.findChannel(req.params.cid, req.user), req.body?.message ?? req.body?.body, {
      replyTo: req.body?.reply_to, attachments: req.body?.attachments, signature: req.body?.signature, scopes: req.scopes,
    }),
  }));
  app.post(v1('/channels/:cid/read'), req => { M.markRead(req.params.cid, req.user, req.body?.id ?? req.body?.message_id); });
  app.get(v1('/channels/:cid/search'), req => M.search(req.params.cid, req.user, req.query.q));
  app.get(v1('/servers/:sid/search'), req => M.searchServer(req.params.sid, req.user, req.query.q, { offset: req.query.offset }));
  app.get(v1('/channels/:cid/pins'), req => M.pins(req.params.cid, req.user));
  app.patch(v1('/messages/:id'), async req => ({ message: await M.editMessage(req.params.id, req.user, req.body?.message ?? req.body?.body, { signature: req.body?.signature, scopes: req.scopes }) }));
  app.delete(v1('/messages/:id'), req => { M.deleteMessage(req.params.id, req.user); });
  app.put(v1('/messages/:id/reactions/:emoji'), req => { M.react(req.params.id, req.user, req.params.emoji, true); });
  app.delete(v1('/messages/:id/reactions/:emoji'), req => { M.react(req.params.id, req.user, req.params.emoji, false); });
  app.put(v1('/messages/:id/pin'), req => { M.pinMessage(req.params.id, req.user, true); });
  app.delete(v1('/messages/:id/pin'), req => { M.pinMessage(req.params.id, req.user, false); });

  // ---- uploads (PROTOCOL §11) ----
  app.post(v1('/media/upload'), async req => {
    if (!req.scopes.includes('media')) throw err('insufficient_scope', 403);
    const sid = String(req.query.sid || '');
    if (!sid) throw err('sid_required');
    const { c, snap } = C.memberCommunity(sid, req.user);
    if (!c.allow_uploads) throw err('uploads_disabled', 403);
    if (!snap.can(req.user.id, require('../perms').P.ATTACH)) throw err('no_attach_permission', 403);
    const maxMb = Math.min(c.upload_max_mb, config.get().max_upload_mb);
    const { buffer, filename } = await uploads.readMultipart(req, { maxBytes: maxMb * 1024 * 1024 });
    if (!buffer || !buffer.length) throw err('no_file');
    return uploads.storeUpload(buffer, filename, req.user.id);
  });

  // ---- export / import (PROTOCOL §9) ----
  app.get(v1('/servers/:sid/export'), (req, res) => {
    const zip = exp.exportCommunity(req.params.sid, req.user);
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${req.params.sid}-export.zip"`, 'Content-Length': zip.length, 'Cache-Control': 'no-store' });
    res.end(zip);
  });
  app.post(v1('/import'), async req => {
    C.assertMayCreate(req.user); // 403 / 409 before we read a (possibly huge) upload
    const { buffer } = await uploads.readMultipart(req, { maxBytes: 256 * 1024 * 1024 });
    if (!buffer) throw err('no_file');
    const c = exp.importCommunity(req.user, buffer);
    return { sid: c.sid };
  });
}
module.exports = { register };
