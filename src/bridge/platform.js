'use strict';
// Discord / Fluxer plumbing for the bridge: the platforms, REST (waits out 429s) and a minimal gateway client.
// The instance owner brings their own bot token for each platform (Instance settings > Bridges). No discord.js:
// the gateway client below speaks just enough of the protocol (hello, identify / resume, heartbeat + ack, reconnect,
// invalid session) to receive MESSAGE_CREATE / UPDATE / DELETE / DELETE_BULK. Fluxer's API is Discord's.
const WebSocket = require('ws');
const store = require('./store');
const { err, log } = require('../util');

const UA = 'Bonfire-Bridge/1.0 (+https://github.com/ikelene/velora)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
// what the bot needs in each server: see channels, read history, send, embed links, attach files, manage messages + webhooks
const BOT_PERMS = String(1024 + 2048 + 8192 + 16384 + 32768 + 65536 + 536870912);
const INTENTS = 1 | 512 | 32768; // GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT

const DEFAULTS = {
  discord: {
    name: 'Discord', api: 'https://discord.com/api/v10', cdn: 'https://cdn.discordapp.com', gateway: null, version: 10, intents: INTENTS,
    invite: id => `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot&permissions=${BOT_PERMS}`,
    jump: (g, c, m) => `https://discord.com/channels/${g}/${c}/${m}`,
    media: /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//i,
  },
  fluxer: {
    name: 'Fluxer', api: null, cdn: 'https://fluxerusercontent.com', gateway: null, version: 1, intents: null,
    discovery: 'https://fluxer.app/.well-known/fluxer',
    invite: id => `https://web.fluxer.app/oauth2/authorize?client_id=${id}&scope=bot&permissions=${BOT_PERMS}`,
    jump: (g, c, m) => `https://web.fluxer.app/channels/${g}/${c}/${m}`,
    media: /^https:\/\/([a-z0-9-]+\.)*(fluxerusercontent\.com|fluxer\.app|fluxerstatic\.com)\//i,
  },
};
const IDS = Object.keys(DEFAULTS);
let P = structuredCloneish(DEFAULTS);
function structuredCloneish(o) { return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { ...v }])); }

// the bot token: Instance settings (bridge_settings) first, then BONFIRE_DISCORD_TOKEN / BONFIRE_FLUXER_TOKEN
const ENV = { discord: 'BONFIRE_DISCORD_TOKEN', fluxer: 'BONFIRE_FLUXER_TOKEN' };
const tokenOf = p => store.setting(`${p}.token`) || process.env[ENV[p]] || '';
const tokenSource = p => (store.setting(`${p}.token`) ? 'settings' : process.env[ENV[p]] ? 'env' : null);
function platform(p) {
  const x = P[p];
  if (!x) throw err('bad_platform', 404);
  return x;
}

// Fluxer publishes its endpoints at a well-known URL (cached for an hour)
const disc = {};
async function endpoints(p) {
  const x = platform(p);
  if (x.api && (x.gateway || !x.discovery)) return { api: x.api, gateway: x.gateway };
  if (!x.discovery) return { api: x.api, gateway: x.gateway };
  const hit = disc[p];
  if (hit && Date.now() - hit.at < 3600e3) return hit.v;
  const r = await fetch(x.discovery, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw Object.assign(new Error(`${p} discovery -> ${r.status}`), { status: r.status });
  const d = await r.json();
  const v = { api: x.api || String(d.endpoints?.api_public || d.endpoints?.api || d.endpoints?.api_client || '').replace(/\/$/, ''), gateway: x.gateway || d.endpoints?.gateway || null };
  if (!v.api) throw new Error(`${p} discovery has no api endpoint`);
  disc[p] = { at: Date.now(), v };
  return v;
}

// REST. auth=false for webhook execution (the webhook token is the key). token overrides the stored one (validation).
async function rest(p, method, route, body, { auth = true, token } = {}) {
  const { api } = await endpoints(p);
  const tok = token ?? tokenOf(p);
  for (let i = 0; i < 5; i++) {
    const r = await fetch(api + route, {
      method,
      headers: { 'User-Agent': UA, ...(auth ? { Authorization: `Bot ${tok}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (r.status === 429) {
      const j = await r.json().catch(() => ({}));
      const wait = Number(j.retry_after) || Number(r.headers.get('retry-after')) || 1;
      await sleep(Math.min(wait, 15) * 1000 + 100);
      continue;
    }
    const t = await r.text();
    if (!r.ok) throw Object.assign(new Error(`${p} ${method} ${route.replace(/\/webhooks\/(\d+)\/[^/?]+/, '/webhooks/$1/***')} -> ${r.status} ${t.slice(0, 200)}`), { status: r.status });
    if (!t) return {};
    try { return JSON.parse(t); } catch { return {}; }
  }
  throw err('rate_limited', 429);
}

async function gatewayUrl(p) {
  const e = await endpoints(p);
  if (e.gateway) return e.gateway;
  if (p === 'discord') {
    const g = await rest(p, 'GET', '/gateway/bot').catch(() => null);
    return g?.url || 'wss://gateway.discord.gg';
  }
  throw new Error(`${p}: no gateway url`);
}

// ---- gateway client ----
const FATAL = { 4004: 'invalid_token', 4010: 'invalid_shard', 4011: 'sharding_required', 4012: 'invalid_api_version', 4013: 'invalid_intents', 4014: 'disallowed_intents' };
class GatewayClient {
  constructor(p, token, onDispatch) {
    this.p = p; this.token = token; this.onDispatch = onDispatch;
    this.state = 'stopped'; this.error = null; this.user = null;
    this.seq = null; this.sessionId = null; this.resumeUrl = null; this.attempts = 0; this.stopped = false;
  }
  start() { this.stopped = false; this.open().catch(e => this.retry(e.message)); }
  async open() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.state = 'connecting';
    const x = platform(this.p);
    const base = this.resumeUrl || await gatewayUrl(this.p);
    if (this.stopped) return;
    const u = new URL(String(base));
    u.searchParams.set('v', String(x.version));
    u.searchParams.set('encoding', 'json');
    const ws = new WebSocket(u.href, { maxPayload: 16 * 1024 * 1024, handshakeTimeout: 15000, headers: { 'User-Agent': UA } });
    this.ws = ws;
    ws.on('message', raw => { let m; try { m = JSON.parse(String(raw)); } catch { return; } this.onFrame(ws, m); });
    ws.on('error', e => { this.lastError = e.message; });
    ws.on('close', code => this.onClose(ws, code));
  }
  send(ws, o) { if (ws.readyState === 1) { try { ws.send(JSON.stringify(o)); } catch { /* closing */ } } }
  onFrame(ws, m) {
    if (m.s != null) this.seq = m.s;
    if (m.op === 10) {
      const every = Number(m.d?.heartbeat_interval) || 41250;
      this.acked = true;
      clearTimeout(this.firstBeat); clearInterval(this.beat);
      const beat = () => {
        if (!this.acked) { try { ws.terminate(); } catch { /* gone */ } return; } // zombie connection: reconnect + resume
        this.acked = false;
        this.send(ws, { op: 1, d: this.seq });
      };
      this.firstBeat = setTimeout(() => { beat(); this.beat = setInterval(beat, every); this.beat.unref?.(); }, Math.floor(every * Math.random()));
      this.firstBeat.unref?.();
      if (this.sessionId && this.seq != null) this.send(ws, { op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.seq } });
      else {
        const x = platform(this.p);
        this.send(ws, { op: 2, d: { token: this.token, ...(x.intents != null ? { intents: x.intents } : {}), properties: { os: process.platform, browser: 'bonfire-server', device: 'bonfire-server' } } });
      }
    } else if (m.op === 11) this.acked = true;
    else if (m.op === 1) this.send(ws, { op: 1, d: this.seq });
    else if (m.op === 7) { try { ws.close(4900, 'reconnect'); } catch { /* gone */ } }
    else if (m.op === 9) {
      if (!m.d) { this.sessionId = null; this.seq = null; this.resumeUrl = null; }
      setTimeout(() => { try { ws.close(4900, 'invalid session'); } catch { /* gone */ } }, 1000 + Math.random() * 2000).unref?.();
    } else if (m.op === 0) {
      if (m.t === 'READY') {
        this.sessionId = m.d?.session_id || null;
        this.resumeUrl = m.d?.resume_gateway_url || null;
        this.user = m.d?.user || m.d?.self_user || null;
        this.state = 'ready'; this.error = null; this.attempts = 0;
        log(`[bridge] ${this.p} gateway ready as ${this.user?.username || '?'}`);
      } else if (m.t === 'RESUMED') { this.state = 'ready'; this.error = null; this.attempts = 0; }
      else if (/^MESSAGE_(CREATE|UPDATE|DELETE|DELETE_BULK)$/.test(m.t || '')) {
        try { const r = this.onDispatch(this.p, m.t, m.d); if (r?.catch) r.catch(e => console.error(`[bridge] ${this.p} ${m.t}`, e.message)); } catch (e) { console.error(`[bridge] ${this.p} ${m.t}`, e.message); }
      }
    }
  }
  onClose(ws, code) {
    clearTimeout(this.firstBeat); clearInterval(this.beat);
    if (this.ws === ws) this.ws = null;
    if (this.stopped) { this.state = 'stopped'; return; }
    if (FATAL[code]) { this.state = 'error'; this.error = FATAL[code]; log(`[bridge] ${this.p} gateway closed for good: ${FATAL[code]}`); return; }
    if (code === 4007 || code === 4009) { this.sessionId = null; this.seq = null; this.resumeUrl = null; }
    this.retry(`closed_${code}`);
  }
  retry(why) {
    if (this.stopped) return;
    this.attempts++;
    if (this.attempts > 3) this.resumeUrl = null; // the resume host may be gone: start over from the main gateway
    const wait = Math.min(1000 * 2 ** Math.min(this.attempts - 1, 6), 60000) + Math.random() * 1000;
    this.state = 'waiting'; this.error = String(why || 'closed').slice(0, 80);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open().catch(e => this.retry(e.message)), wait);
    this.timer.unref?.();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer); clearTimeout(this.firstBeat); clearInterval(this.beat);
    if (this.ws) { try { this.ws.close(1000); } catch { /* gone */ } const w = this.ws; setTimeout(() => { try { w.terminate(); } catch { /* gone */ } }, 2000).unref?.(); }
    this.state = 'stopped';
  }
}

// tests point the platforms at local fakes
const _test = {
  set(p, o) { Object.assign(P[p], o); delete disc[p]; },
  reset() { P = structuredCloneish(DEFAULTS); for (const k of Object.keys(disc)) delete disc[k]; },
};

module.exports = { IDS, platform, tokenOf, tokenSource, rest, endpoints, gatewayUrl, GatewayClient, UA, BOT_PERMS, INTENTS, _test };
