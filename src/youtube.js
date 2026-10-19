'use strict';
// "Watch through the instance": the client's YouTube player without YouTube (ported from Velora's routes/chat-yt.js).
// The instance fetches the video with yt-dlp, keeps it for 24 hours (every watch pushes that back) and streams it from here.
// OPTIONAL: needs a yt-dlp binary ("install yt-dlp to enable"). Detected at boot (`yt-dlp --version`) and whenever the
// `youtube` settings change; features.youtube in discovery says whether it works, and every route answers
// 503 { error: 'youtube_unavailable' } while it doesn't.
//   POST /api/v1/yt/:id/prepare   start fetching (session)  -> { status, progress | src, download }
//   GET  /api/v1/yt/:id/status    how it's going (session)
//   POST /api/v1/yt/:id/save      copy into the instance uploads as a video attachment (session + media scope)
//   GET  /api/v1/yt/stream/:id    the video, via an HMAC-signed link so <video> can play it (?dl=1 = download)
// yt-dlp is always spawned with an argument array (never a shell), and only ever sees a validated 11-character id.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const uploads = require('./uploads');
const { err, normalizeOrigin, randHex, now, sha256 } = require('./util');

const ID = /^[A-Za-z0-9_-]{11}$/;
const SECRET = crypto.randomBytes(32); // per process: links stop working on a restart, the player just asks again
const KEEP_MS = 24 * 3600 * 1000, LINK_MS = 6 * 3600 * 1000, MAX_SECONDS = 2 * 3600, MAX_JOBS = 2, MIN_FREE = 1024 ** 3;

let available = false, version = null, lastCfg = '', hooked = false, trimTimer = null;
const jobs = new Map();     // id -> { progress, part, error, started, at }
const watching = new Map(); // id -> open streams (a video being watched never expires mid-watch)
const children = new Set();
const queue = [];
let running = 0;

const cfg = () => config.get().youtube;
const dir = () => cfg().cache_dir || path.join(config.dir(), 'cache', 'yt');
const file = id => path.join(dir(), `${id}.mp4`);
const enabled = () => !!cfg().enabled && available;
const need = () => { if (!enabled()) throw err('youtube_unavailable', 503); };
const validId = id => ID.test(String(id || ''));
const checkId = id => { if (!validId(id)) throw err('bad_video', 400); return id; };

// ---- detection ----
function detect() {
  lastCfg = JSON.stringify(cfg());
  return new Promise(resolve => {
    available = false; version = null;
    if (!cfg().enabled) return resolve(false);
    let out = '', done = false;
    const end = ok => { if (done) return; done = true; clearTimeout(timer); available = ok; if (ok) { try { fs.mkdirSync(dir(), { recursive: true }); } catch { available = false; } } resolve(available); };
    let p;
    try { p = spawn(cfg().ytdlp_path || 'yt-dlp', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return end(false); }
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } end(false); }, 8000);
    p.stdout.on('data', d => { out += d; });
    p.on('error', () => end(false));
    p.on('close', code => { version = code === 0 ? out.trim().slice(0, 40) || null : null; end(code === 0); });
  });
}
async function init() {
  await detect();
  if (!hooked) { hooked = true; config.events.on('change', () => { if (db.raw() && JSON.stringify(cfg()) !== lastCfg) detect().then(() => available && trim()).catch(() => {}); }); }
  clearInterval(trimTimer);
  if (available) { trim(); trimTimer = setInterval(() => { try { trim(); } catch { /* cache dir gone */ } }, 30 * 60 * 1000); trimTimer.unref(); }
}
function shutdown() { clearInterval(trimTimer); for (const p of children) { try { p.kill('SIGKILL'); } catch { /* gone */ } } children.clear(); queue.length = 0; }

// ---- signed links ----
const sign = (id, exp, dl) => crypto.createHmac('sha256', SECRET).update(`${id}.${exp}.${dl ? 1 : 0}`).digest('base64url');
function streamUrl(id, dl) {
  const exp = now() + LINK_MS;
  return `${normalizeOrigin(config.publicUrl())}/api/v1/yt/stream/${id}?e=${exp}&s=${sign(id, exp, dl)}${dl ? '&dl=1' : ''}`;
}
function verifyLink(id, e, s, dl) {
  const exp = Number(e) || 0;
  if (!validId(id) || exp <= now() || typeof s !== 'string' || s.length !== 43) return false;
  return crypto.timingSafeEqual(Buffer.from(sign(id, exp, !!dl)), Buffer.from(s));
}

// ---- fetching ----
function statusOf(id) {
  if (fs.existsSync(file(id))) return { status: 'ready', src: streamUrl(id, false), download: streamUrl(id, true) };
  const j = jobs.get(id);
  if (!j) return { status: 'none', can_download: true };
  if (j.error) return { status: 'error', error: j.error };
  return { status: j.started ? 'downloading' : 'queued', progress: Math.round(j.progress || 0), part: j.part || 1 };
}
function freeBytes() { try { const s = fs.statfsSync(dir()); return s.bavail * s.bsize; } catch { return Infinity; } }
function start(id) {
  const j = jobs.get(id);
  if (j && !j.error) return;
  if (freeBytes() < MIN_FREE) { jobs.set(id, { error: 'server_busy', at: now() }); return; }
  jobs.set(id, { progress: 0 });
  queue.push(id);
  pump();
}
function pump() { while (running < MAX_JOBS && queue.length) run(queue.shift()); }
function run(id) {
  running++;
  const j = jobs.get(id);
  j.started = true;
  const out = path.join(dir(), `${id}.dl.%(ext)s`);
  const args = ['--no-playlist', '--newline', '--no-mtime', '--no-part',
    '-f', 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/bv*[height<=720]+ba/b[height<=720]/b',
    '--merge-output-format', 'mp4', '--match-filter', `duration<=${MAX_SECONDS} & !is_live`, '--max-filesize', '900M',
    '-o', out, `https://www.youtube.com/watch?v=${id}`];
  let p, log = '';
  const finish = code => {
    running--;
    const made = path.join(dir(), `${id}.dl.mp4`);
    if (code === 0 && fs.existsSync(made)) { fs.renameSync(made, file(id)); jobs.delete(id); }
    else {
      j.error = /does not pass filter/i.test(log) ? 'too_long' : /private video|sign in|age/i.test(log) ? 'not_available' : 'failed';
      j.at = now();
      if (j.error === 'failed') console.error('[yt]', id, log.slice(-500));
    }
    try { for (const f of fs.readdirSync(dir())) if (f.startsWith(`${id}.dl.`)) fs.rmSync(path.join(dir(), f), { force: true }); trim(); } catch { /* cache dir gone */ }
    pump();
  };
  try { p = spawn(cfg().ytdlp_path || 'yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return finish(1); }
  children.add(p);
  const eat = d => {
    const t = d.toString();
    log = (log + t).slice(-4000);
    if (/\[download\] Destination:/.test(t)) j.part = (j.part || 0) + 1;
    const m = /\[download\]\s+([\d.]+)%/g;
    let x, last = null;
    while ((x = m.exec(t))) last = x[1];
    if (last) j.progress = Number(last);
  };
  p.stdout.on('data', eat);
  p.stderr.on('data', eat);
  const killer = setTimeout(() => p.kill('SIGKILL'), 20 * 60 * 1000);
  let ended = false;
  const once = code => { if (ended) return; ended = true; clearTimeout(killer); children.delete(p); finish(code); };
  p.on('error', () => once(1));
  p.on('close', once);
}
// keep the cache under cache_max_gb (least recently watched first) and drop anything not watched for a day
function trim() {
  let list = [];
  const d = dir();
  for (const f of fs.readdirSync(d)) {
    if (!/^[A-Za-z0-9_-]{11}\.mp4$/.test(f)) continue;
    try { const st = fs.statSync(path.join(d, f)); list.push({ f, size: st.size, at: st.mtimeMs }); } catch { /* gone */ }
  }
  const t = now(), busy = x => watching.get(x.f.slice(0, 11)) > 0, rm = x => fs.rmSync(path.join(d, x.f), { force: true });
  list.filter(x => t - x.at > KEEP_MS && !busy(x)).forEach(rm);
  list = list.filter(x => t - x.at <= KEEP_MS || busy(x)).sort((a, b) => a.at - b.at);
  const cap = Math.max(0.1, Number(cfg().cache_max_gb) || 5) * 1024 ** 3;
  let total = list.reduce((n, x) => n + x.size, 0);
  for (const x of list) { if (total <= cap) break; if (busy(x)) continue; rm(x); total -= x.size; }
  for (const [id, j] of jobs) if (j.error && t - j.at > 10 * 60 * 1000) jobs.delete(id); // errors are retried after 10 minutes
}

// ---- route bodies ----
function prepare(id) { need(); checkId(id); if (!fs.existsSync(file(id))) start(id); return statusOf(id); }
function status(id) { need(); checkId(id); return statusOf(id); }
// a copy as a regular upload (message attachment); fetches first when needed - call again when ready
async function save(id, user, title) {
  need(); checkId(id);
  if (!fs.existsSync(file(id))) { start(id); return statusOf(id); }
  const c = db.get('SELECT * FROM communities ORDER BY id LIMIT 1');
  if (c && !c.allow_uploads) throw err('uploads_disabled', 403);
  const size = fs.statSync(file(id)).size;
  if (size > (c ? require('./communities').effectiveUploadMax(c, require('./communities').snapOf(c), user) : config.get().max_upload_mb) * 1024 * 1024) throw err('file_too_large', 413);
  const safe = String(title || '').replace(/&[#\w]+;/g, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || `youtube_${id}`;
  const name = `${safe}.mp4`, d = new Date();
  const rel = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${randHex(12)}.mp4`;
  const dest = path.join(uploads.root(), rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file(id), dest);
  const hash = await new Promise((resolve, reject) => { const h = crypto.createHash('sha256'); fs.createReadStream(dest).on('data', x => h.update(x)).on('end', () => resolve(h.digest('hex'))).on('error', reject); });
  db.run('INSERT INTO uploads (path, sha256, name, size, mime, type, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', rel, hash, name, size, 'video/mp4', 'video', user.id, now());
  const url = `${normalizeOrigin(config.publicUrl())}/uploads/${rel}`;
  return { status: 'saved', id: rel, attachment: { url, type: 'video', name, size, sha256: hash } };
}
// GET the video (Range supported so <video> can seek)
function stream(req, res) {
  need();
  const { id } = req.params, dl = req.query.dl === '1';
  if (!verifyLink(id, req.query.e, req.query.s, dl)) throw err('link_expired', 403);
  const f = file(id);
  let st; try { st = fs.statSync(f); } catch { throw err('not_ready', 404); }
  const touch = () => { const t = new Date(); fs.utimes(f, t, t, () => {}); };
  touch(); // the 24 hours restart when someone starts watching, and don't run while they are
  watching.set(id, (watching.get(id) || 0) + 1);
  res.on('close', () => { const n = (watching.get(id) || 1) - 1; if (n > 0) watching.set(id, n); else watching.delete(id); touch(); });
  const headers = { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, max-age=3600', 'Accept-Ranges': 'bytes', 'Cross-Origin-Resource-Policy': 'cross-origin' };
  if (dl) headers['Content-Disposition'] = `attachment; filename="youtube-${id}.mp4"`;
  let start = 0, end = st.size - 1, code = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), end); } else start = Math.max(0, st.size - Number(m[2]));
    if (start > end || start >= st.size) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    code = 206; headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(code, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(f, { start, end }).on('error', () => res.destroy()).pipe(res);
}

module.exports = { init, detect, shutdown, enabled, version: () => version, prepare, status, save, stream, validId, sign, verifyLink, streamUrl, dir };
