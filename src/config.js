'use strict';
// DATA_DIR/config.json is the source of truth for instance settings; a few env vars override it.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { err, normalizeOrigin } = require('./util');

const events = new EventEmitter();
let DATA_DIR = path.resolve(process.env.BONFIRE_DATA || './data');
let PORT = Number(process.env.PORT) || 4100;
let file = null;
let data = {};
let runningMode = null; // accounts_mode is fixed until restart
let watcher = null, lastWritten = null, debounce = null;

const DEFAULTS = {
  name: 'Bonfire Instance', description: '', icon_url: null, public_url: null,
  accounts_mode: 'local', velora_url: 'https://velora.ikelene.net',
  registration: 'open', max_upload_mb: 25,
  voice: { cf_app_id: '', cf_app_secret: '', cf_turn_key_id: '', cf_turn_token: '' },
};

function init({ dataDir, port } = {}) {
  if (dataDir) DATA_DIR = path.resolve(dataDir);
  if (port) PORT = port;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  file = path.join(DATA_DIR, 'config.json');
  data = {};
  reload(true);
  if (!fs.existsSync(file)) write();
  runningMode = get().accounts_mode;
}

function reload(quiet) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { if (e.code !== 'ENOENT' && !quiet) console.error('[config] could not read config.json:', e.message); }
  try { data = sanitize(raw, true); } catch (e) { console.error('[config] invalid config.json, keeping previous values:', e.message); }
}

// validate a (partial) settings object. loose = ignore unknown keys / bad values quietly (hand-edited file)
function sanitize(p, loose = false) {
  const out = {};
  const bad = code => { if (!loose) throw err(code, 400); };
  const str = (k, n) => { if (p[k] !== undefined) { if (typeof p[k] === 'string' && p[k].length <= n) out[k] = p[k].trim(); else bad('invalid_' + k); } };
  str('name', 60); str('description', 300); // same limits as the community's (they are the same values, PROTOCOL §5a)
  if (out.name === '') { delete out.name; bad('invalid_name'); }
  if (p.icon_url !== undefined) { if (p.icon_url === null || p.icon_url === '') out.icon_url = null; else if (typeof p.icon_url === 'string' && p.icon_url.length < 512) out.icon_url = p.icon_url; else bad('invalid_icon_url'); }
  for (const k of ['public_url', 'velora_url']) {
    if (p[k] === undefined) continue;
    const o = typeof p[k] === 'string' ? normalizeOrigin(p[k]) : null;
    if (o) out[k] = o; else if (p[k] === null && k === 'public_url') out[k] = null; else bad('invalid_' + k);
  }
  if (p.accounts_mode !== undefined) { if (['velora', 'local'].includes(p.accounts_mode)) out.accounts_mode = p.accounts_mode; else bad('invalid_accounts_mode'); }
  if (p.registration !== undefined) { if (['open', 'closed'].includes(p.registration)) out.registration = p.registration; else bad('invalid_registration'); }
  if (p.max_upload_mb !== undefined) { const n = Number(p.max_upload_mb); if (Number.isInteger(n) && n >= 1 && n <= 500) out.max_upload_mb = n; else bad('invalid_max_upload_mb'); }
  if (p.voice !== undefined) {
    if (p.voice && typeof p.voice === 'object') {
      const v = {};
      for (const k of ['cf_app_id', 'cf_app_secret', 'cf_turn_key_id', 'cf_turn_token']) if (p.voice[k] !== undefined) { if (typeof p.voice[k] === 'string' && p.voice[k].length < 300) v[k] = p.voice[k].trim(); else bad('invalid_voice'); }
      out.voice = v;
    } else bad('invalid_voice');
  }
  return out;
}

// the effective settings: defaults < file < env. (Old community_creation / auto_join keys in config.json are ignored.)
function get() {
  const v = { ...DEFAULTS, ...data, voice: { ...DEFAULTS.voice, ...(data.voice || {}) } };
  if (process.env.BONFIRE_ACCOUNTS_MODE && ['velora', 'local'].includes(process.env.BONFIRE_ACCOUNTS_MODE)) v.accounts_mode = process.env.BONFIRE_ACCOUNTS_MODE;
  if (process.env.BONFIRE_VELORA_URL) v.velora_url = normalizeOrigin(process.env.BONFIRE_VELORA_URL) || v.velora_url;
  v.public_url = normalizeOrigin(process.env.BONFIRE_PUBLIC_URL || v.public_url || `http://localhost:${PORT}`);
  v.velora_url = normalizeOrigin(v.velora_url);
  return v;
}
// the mode this process booted with (switching needs a restart)
const mode = () => runningMode || get().accounts_mode;
const publicUrl = () => get().public_url;

function update(patch) {
  const clean = sanitize(patch || {});
  if (clean.voice) { // secrets are write-only: an empty/omitted secret keeps the old one
    const cur = data.voice || {};
    clean.voice = { ...cur, ...Object.fromEntries(Object.entries(clean.voice).filter(([k, v]) => v !== '' || !/secret|token/.test(k))) };
  }
  data = { ...data, ...clean };
  write();
  events.emit('change');
  return get();
}

function write() {
  const text = JSON.stringify(data, null, 2) + '\n';
  lastWritten = text;
  fs.writeFileSync(file + '.tmp', text, { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

function watch() {
  if (watcher) return;
  try {
    watcher = fs.watch(DATA_DIR, (ev, name) => {
      if (name !== 'config.json') return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
        if (text === lastWritten) return; // our own write
        lastWritten = text;
        reload();
        console.log('[config] config.json changed, reloaded');
        events.emit('change');
      }, 150);
    });
    watcher.on('error', () => {});
  } catch (e) { console.error('[config] cannot watch config.json:', e.message); }
}
function unwatch() { clearTimeout(debounce); watcher?.close(); watcher = null; }

// settings shown to admins (voice secrets are write-only)
function adminView() {
  const v = get();
  return {
    name: v.name, description: v.description, icon_url: v.icon_url, public_url: v.public_url,
    accounts_mode: data.accounts_mode || v.accounts_mode, running_accounts_mode: mode(), restart_required: (data.accounts_mode || v.accounts_mode) !== mode(),
    velora_url: v.velora_url, registration: v.registration, max_upload_mb: v.max_upload_mb,
    voice: { cf_app_id: v.voice.cf_app_id, has_app_secret: !!v.voice.cf_app_secret, cf_turn_key_id: v.voice.cf_turn_key_id, has_turn_token: !!v.voice.cf_turn_token },
  };
}
// what any connected client may see (instance_update)
function publicView() {
  const v = get();
  return { name: v.name, description: v.description, icon_url: v.icon_url, registration: v.registration, max_upload_mb: v.max_upload_mb, accounts_mode: mode() };
}
const voiceConfigured = () => { const v = get().voice; return !!(v.cf_app_id && v.cf_app_secret && v.cf_turn_key_id && v.cf_turn_token); };

module.exports = { init, get, mode, publicUrl, update, watch, unwatch, adminView, publicView, voiceConfigured, events, dir: () => DATA_DIR, port: () => PORT, setPort: p => { PORT = p; }, DEFAULTS };
