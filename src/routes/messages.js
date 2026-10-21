'use strict';
// Messages, uploads, export / import.
const config = require('../config');
const C = require('../communities');
const M = require('../messages');
const uploads = require('../uploads');
const exp = require('../export');
const managed = require('../managed');
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
  // Both paths use the same scopes, membership, channel permission and size limit.
  function uploadContext(req) {
    if (!req.scopes.includes('media')) throw err('insufficient_scope', 403);
    const sid = String(req.query.sid || '');
    if (!sid) throw err('sid_required');
    const { c, snap } = C.memberCommunity(sid, req.user);
    if (!c.allow_uploads) throw err('uploads_disabled', 403);
    const { P } = require('../perms');
    if (req.query.cid) {
      const { ch } = C.findChannel(req.query.cid, req.user);
      if (ch.community_id !== c.id) throw err('channel_not_found', 404);
      if (!(snap.chPerms(ch, req.user.id) & P.ATTACH)) throw err('no_attach_permission', 403);
    } else if (!snap.can(req.user.id, P.ATTACH)) throw err('no_attach_permission', 403);
    if (managed.limit('max_upload_mb') === 0) throw managed.planFeature('max_upload_mb');
    const rules = uploads.beforeUpload(c, snap, req.user); // Server settings > Uploads: per minute, files each member keeps, storage
    return { maxMb: C.effectiveUploadMax(c, snap, req.user), c, rules };
  }
  function uploadError(maxMb) {
    return managed.limit('max_upload_mb') === maxMb
      ? managed.planLimit('max_upload_mb', maxMb, null)
      : err('file_too_large', 413, { max_mb: maxMb });
  }
  app.post(v1('/media/upload'), async req => {
    const { maxMb, c, rules } = uploadContext(req);
    let data;
    try { data = await uploads.readMultipart(req, { maxBytes: maxMb * 1024 * 1024 }); }
    catch (e) { if (e.code === 'file_too_large') throw uploadError(maxMb); throw e; }
    const { buffer, filename, fields } = data;
    if (!buffer || !buffer.length) throw err('no_file');
    return uploads.acceptUpload(c, req.user, buffer, filename, rules, { expiresInDays: fields?.expires_in_days ?? req.query.expires_in_days });
  });
  // Import on the instance: browser CORS must not decide whether saved media can be sent.
  app.post(v1('/media/import'), async req => {
    const { maxMb, c, rules } = uploadContext(req);
    let url;
    try { url = new URL(req.body?.url); } catch { throw err('invalid_media_url'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 4096) throw err('invalid_media_url');
    let result;
    try { result = await require('../unfurl').fetchSafe(url.href, { maxBytes: maxMb * 1024 * 1024 }); }
    catch { throw err('media_import_failed', 422); }
    if (result.cut) throw uploadError(maxMb);
    if (result.status !== 200 || !result.body.length) throw err('media_import_failed', 422);
    return uploads.acceptUpload(c, req.user, result.body, req.body?.name || 'attachment', rules, { expiresInDays: req.body?.expires_in_days });
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
