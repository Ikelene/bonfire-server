'use strict';
// Velora relays, instance side (PROTOCOL §12): the instance key, registration with Velora (§12.1) and the signed
// request client every relay feature uses (§12.2). Nothing here ever blocks startup: registration runs in the
// background with backoff, and `velora_registration: "off"` means this instance never contacts Velora at all.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const config = require('../config');
const db = require('../db');
const { err, sha256, log } = require('../util');

const events = new EventEmitter(); // 'registered' (state), 'unregistered'
events.setMaxListeners(50);

// ---------- instance key (DATA_DIR/keys/instance.key, PKCS#8 PEM, 0600) ----------
let key = null; // { file, priv, pubkey (b64url raw 32 bytes), id ('ik_' + 16 hex) }
function loadKey() {
  const file = path.join(config.dir(), 'keys', 'instance.key');
  if (key && key.file === file) return key;
  let priv;
  try { priv = crypto.createPrivateKey(fs.readFileSync(file)); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    priv = crypto.generateKeyPairSync('ed25519').privateKey;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, priv.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  const pubkey = crypto.createPublicKey(priv).export({ format: 'jwk' }).x;
  key = { file, priv, pubkey, id: 'ik_' + sha256(Buffer.from(pubkey, 'base64url')).slice(0, 16) };
  return key;
}
const identity = () => { const k = loadKey(); return { instance_key: k.pubkey, instance_id: k.id }; };
const sign = text => crypto.sign(null, Buffer.from(text), loadKey().priv).toString('base64url');

// ---------- state ----------
const enabled = () => config.get().velora_registration !== 'off';
const target = () => { const c = config.get(); return `${c.velora_url}|${c.public_url}`; };
const stateOf = () => { try { return JSON.parse(db.metaGet('velora_reg') || 'null'); } catch { return null; } };
function saveState(s) { db.metaSet('velora_reg', JSON.stringify(s)); }
let lastError = null;
// registered = Velora accepted THIS key for THIS (velora_url, public_url) pair
function registered() {
  if (!enabled()) return false;
  const s = stateOf();
  return !!(s && s.instance_id === loadKey().id && s.for === target());
}
const trusted = () => registered() && !!stateOf()?.trusted;
function setTrusted(v) { const s = stateOf(); if (s && s.trusted !== !!v) { s.trusted = !!v; saveState(s); } }
// voice cap info, refreshed by every broker reply that carries `voice`
function setVoice(v) {
  if (!v || typeof v !== 'object') return;
  const s = stateOf(); if (!s) return;
  s.voice = { cap_minutes: v.cap_minutes ?? null, used_minutes: Number(v.used_minutes) || 0 };
  saveState(s);
}
function status() {
  const s = registered() ? stateOf() : null;
  return {
    registration: config.get().velora_registration, velora_url: config.get().velora_url,
    registered: !!s, instance_id: loadKey().id, trusted: !!s?.trusted,
    voice: s ? { cap_minutes: s.voice?.cap_minutes ?? null, used_minutes: s.voice?.used_minutes ?? 0 } : null,
    registered_at: s?.at || null, last_error: enabled() ? lastError : null,
  };
}

// ---------- HTTP ----------
const inflight = new Set();
async function http(method, url, { body, headers = {}, timeout = 15000, binary = false, maxBytes = 2 * 1024 * 1024 } = {}) {
  const ac = new AbortController();
  inflight.add(ac);
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    let res;
    try { res = await fetch(url, { method, headers, body, signal: ac.signal, redirect: 'error' }); } catch { throw err('velora_unreachable', 502); }
    const len = Number(res.headers.get('content-length')) || 0;
    if (len > maxBytes) { ac.abort(); throw err('velora_response_too_large', 502); }
    const chunks = []; let n = 0;
    try {
      for await (const c of res.body || []) { n += c.length; if (n > maxBytes) { ac.abort(); throw err('velora_response_too_large', 502); } chunks.push(c); }
    } catch (e) { if (e.code) throw e; throw err('velora_unreachable', 502); }
    const buf = Buffer.concat(chunks);
    const isJson = /json/i.test(res.headers.get('content-type') || '');
    let json = null;
    if (isJson || !res.ok) { try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; } }
    if (!res.ok) {
      const { error, ...extra } = json && typeof json === 'object' ? json : {};
      throw err(typeof error === 'string' && /^[a-z0-9_]{1,64}$/.test(error) ? error : `velora_${res.status}`, res.status, { ...extra, ...(res.headers.get('retry-after') ? { retry_after: Number(res.headers.get('retry-after')) || undefined } : {}) });
    }
    if (binary) return buf;
    return json ?? {};
  } finally { clearTimeout(timer); inflight.delete(ac); }
}

// a signed relay request (§12.2): `p` is the request target exactly as sent, path + query (e.g. /bonfire/relay/notify)
async function call(method, p, body, opts = {}) {
  if (!enabled()) throw err('velora_off', 503);
  if (!registered()) throw err('velora_not_registered', 503);
  method = String(method).toUpperCase();
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const ts = Date.now();
  const headers = {
    'X-Bonfire-Instance': loadKey().id, 'X-Bonfire-Ts': String(ts),
    'X-Bonfire-Sig': sign(`${method}|${p}|${ts}|${sha256(payload)}`),
  };
  if (payload.length) headers['Content-Type'] = 'application/json';
  try {
    return await http(method, config.get().velora_url + p, { ...opts, body: payload.length ? payload : undefined, headers });
  } catch (e) {
    if (e.code === 'unknown_instance') { db.metaDel('velora_reg'); events.emit('unregistered'); schedule(2000); } // Velora forgot us (staff removed it): register again
    if (e.code === 'instance_banned') lastError = 'instance_banned';
    throw e;
  }
}

// ---------- registration (§12.1) ----------
async function register() {
  if (!enabled()) throw err('velora_off', 503);
  const cfg = config.get(), k = loadKey(), url = cfg.public_url, forKey = target();
  const json = { 'Content-Type': 'application/json' };
  const ch = await http('POST', `${cfg.velora_url}/bonfire/instances/challenge`, { headers: json, body: JSON.stringify({ pubkey: k.pubkey, url }) });
  if (typeof ch.nonce !== 'string') throw err('velora_bad_response', 502);
  const body = { pubkey: k.pubkey, url, name: String(cfg.name || 'Bonfire Instance').slice(0, 80), accounts_mode: config.mode(), nonce: ch.nonce, sig: sign(`bonfire-register-v1|${ch.nonce}|${url}`) };
  const out = await http('POST', `${cfg.velora_url}/bonfire/instances/register`, { headers: json, body: JSON.stringify(body) });
  if (out.instance_id !== k.id) throw err('velora_bad_response', 502);
  if (forKey !== target()) throw err('settings_changed', 409); // urls changed while we were registering: the next round does it again
  const state = { instance_id: out.instance_id, trusted: !!out.trusted, voice: { cap_minutes: out.voice?.cap_minutes ?? null, used_minutes: Number(out.voice?.used_minutes) || 0 }, for: forKey, at: Date.now(), fp: fingerprint() };
  saveState(state);
  lastError = null;
  log(`[velora] registered with ${cfg.velora_url} as ${out.instance_id}${out.trusted ? ' (trusted)' : ''}`);
  events.emit('registered', state);
  return status();
}

// owner attestation (PROTOCOL §12.1): the owner carries this to Velora (POST /bonfire/instances/payout) to become the payee
const ATTEST_TTL = 300;
function ownerAttestation(veloraId) {
  const k = loadKey(), iat = Math.floor(Date.now() / 1000);
  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = enc({ alg: 'EdDSA', typ: 'bonfire-owner+jwt' }) + '.' + enc({ iss: k.id, url: config.get().public_url, sub: String(veloraId), iat, exp: iat + ATTEST_TTL, jti: crypto.randomBytes(16).toString('base64url') });
  return input + '.' + sign(input);
}

// what registration depends on: a change re-registers
const fingerprint = () => { const c = config.get(); return [c.velora_registration, c.velora_url, c.public_url, c.name, config.mode()].join('|'); };
const BACKOFF = [5e3, 15e3, 60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3];
const REFRESH = 12 * 3600e3; // trusted / voice cap can change on Velora's side
let timer = null, attempt = 0, running = false, started = false, lastFp = null;
function schedule(ms) {
  clearTimeout(timer); timer = null;
  if (!started || !enabled()) return;
  timer = setTimeout(round, ms);
  timer.unref?.();
}
async function round() {
  timer = null;
  if (running || !enabled()) return;
  running = true;
  try { await register(); attempt = 0; schedule(REFRESH); } catch (e) {
    lastError = e.code || e.message;
    // permanent refusals still retry, just slowly (staff can lift a ban / free a url)
    const slow = ['instance_banned', 'url_taken', 'url_unverified', 'invalid_url'].includes(e.code);
    const wait = slow ? BACKOFF[BACKOFF.length - 1] : BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
    attempt++;
    if (attempt === 1 || slow || attempt % 5 === 0) log(`[velora] registration failed (${lastError}); retrying in ${Math.round(wait / 1000)}s`);
    schedule(wait);
  } finally { running = false; }
}
function onConfig() {
  const fp = fingerprint();
  if (fp === lastFp) return;
  lastFp = fp;
  attempt = 0;
  if (!enabled()) { clearTimeout(timer); timer = null; lastError = null; events.emit('unregistered'); return; }
  schedule(registered() && stateOf()?.fp === fp ? REFRESH : 1000);
}
// after the HTTP server listens (Velora checks our discovery document while registering)
function start() {
  if (started) return;
  started = true;
  lastFp = fingerprint();
  config.events.on('change', onConfig);
  if (!enabled()) return;
  if (registered()) events.emit('registered', stateOf());
  schedule(registered() && stateOf()?.fp === lastFp && Date.now() - (stateOf()?.at || 0) < REFRESH ? REFRESH : 200);
}
function stop() {
  started = false;
  clearTimeout(timer); timer = null;
  config.events.off('change', onConfig);
  for (const ac of inflight) ac.abort();
  inflight.clear();
  events.removeAllListeners();
  key = null; lastError = null; attempt = 0;
}
// manual "register now" (admins)
async function registerNow() {
  const out = await register();
  attempt = 0; schedule(REFRESH);
  return out;
}

module.exports = { loadKey, identity, sign, enabled, registered, trusted, setTrusted, setVoice, status, call, http, register, registerNow, ownerAttestation, start, stop, events, stateOf };
