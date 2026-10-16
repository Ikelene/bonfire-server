'use strict';
// POST /api/v1/webhooks/:wid/:token - the same body Discord webhooks take (content, username, avatar_url, embeds[], or multipart with
// payload_json + files), so most tools that post to Discord work by swapping the URL. ?wait=true returns the message. No login: the
// token is the key. Errors use Discord's { message, code } shape here.
const webhooks = require('../webhooks');
const uploads = require('../uploads');

function register(app) {
  const route = (fn) => async (req, res) => {
    try { return await fn(req, res); } catch (e) {
      const status = e.status || (e.code ? 400 : 500);
      if (!e.code) console.error('[hooks]', e.stack || e.message);
      if (res.headersSent) return;
      if (status === 429) return app.send(res, 429, { message: 'You are being rate limited.', retry_after: e.extra?.retry_after || 1, global: false });
      app.send(res, status, { message: e.code || 'Server error', code: e.payload ? 50109 : 0 });
    }
  };
  const A = { auth: false };
  const P = '/api/v1/webhooks/:wid/:token';
  app.get(P, A, route(req => webhooks.info(req.params.wid, req.params.token)));
  app.post(P, A, route(async (req, res) => {
    let body = req.body || {}, files = [];
    if (/^multipart\//i.test(req.headers['content-type'] || '')) {
      const f = await uploads.readForm(req);
      body = f.fields; files = f.files;
    }
    if (body.payload_json != null) {
      try { body = JSON.parse(body.payload_json); } catch { throw Object.assign(new Error('Invalid payload_json'), { code: 'Invalid payload_json', status: 400, payload: true }); }
    }
    const msg = webhooks.execute(req.params.wid, req.params.token, body, files);
    if (String(req.query.wait) === 'true') return msg;
    res.writeHead(204); res.end();
  }));
  app.delete(P, A, route((req, res) => { webhooks.removeByToken(req.params.wid, req.params.token); res.writeHead(204); res.end(); }));
}
module.exports = { register };
