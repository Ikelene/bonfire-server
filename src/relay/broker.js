'use strict';
// Velora's voice broker (PROTOCOL §12.7): the Cloudflare Realtime calls of voice.js, made through signed relay routes when
// the instance has no Cloudflare keys of its own. Open sessions get a heartbeat every minute (Velora closes sessions that
// stay silent for 10 minutes and meters per instance per month).
const client = require('./client');
const config = require('../config');
const { err } = require('../util');

const live = new Set(); // broker session ids this process opened and has not closed
let hb = null, reprobe = null, HB_MS = 60 * 1000;
let state = { ok: null, capped: false, at: 0 }; // ok: null = not probed yet, false = Velora has no voice set up
let ice = null; // { at, servers }

async function rc(method, sub, body) {
  let out;
  try { out = await client.call(method, '/bonfire/relay/rtc' + sub, body, { timeout: 15000 }); } catch (e) {
    if (e.code === 'voice_cap_reached') { state.capped = true; client.setVoice({ cap_minutes: e.extra?.cap_minutes, used_minutes: e.extra?.used_minutes }); throw err('voice_cap_reached', 402, { cap_minutes: e.extra?.cap_minutes ?? null, used_minutes: e.extra?.used_minutes ?? null }); }
    if (e.code === 'voice_unavailable' || e.code === 'velora_not_registered' || e.code === 'velora_off') { if (e.code === 'voice_unavailable') state.ok = false; throw err('voice_unavailable', 503); }
    if (e.code === 'session_not_found') throw err('voice_session_lost', 410);
    throw err('voice_upstream', 502);
  }
  if (out?.voice) { client.setVoice(out.voice); if (out.voice.over === false) state.capped = false; }
  return out;
}
function beat() {
  if (!live.size) { clearInterval(hb); hb = null; return; }
  rc('POST', '/heartbeat', { sessionIds: [...live].slice(0, 400) }).catch(() => {});
}
function ensureBeat() { if (!hb && live.size) { hb = setInterval(beat, HB_MS); hb.unref?.(); } }

// the voice.js backend interface (same as its direct Cloudflare one)
const R = {
  async createSession() {
    const out = await rc('POST', '/session', {});
    if (typeof out.sessionId !== 'string') throw err('voice_upstream', 502);
    live.add(out.sessionId); ensureBeat();
    return out.sessionId;
  },
  publish: (sessionId, sessionDescription, tracks) => rc('POST', '/tracks', { sessionId, sessionDescription, tracks: tracks.map(t => ({ mid: t.mid, trackName: t.trackName })) }),
  subscribe: (sessionId, tracks) => rc('POST', '/tracks', { sessionId, tracks: tracks.map(t => ({ sessionId: t.sessionId, trackName: t.trackName })) }),
  renegotiate: (sessionId, sessionDescription) => rc('POST', '/renegotiate', { sessionId, sessionDescription }),
  closeTracks: (sessionId, mids) => rc('POST', '/close', { sessionId, mids }),
  async closeSession(sessionId) {
    if (!sessionId) return;
    live.delete(sessionId);
    await rc('POST', '/close', { sessionId });
  },
  async iceServers() {
    if (ice && Date.now() - ice.at < 10 * 60 * 1000) return ice.servers;
    const out = await rc('GET', '/ice');
    if (!Array.isArray(out.iceServers)) throw err('voice_upstream', 502);
    state.ok = true; state.capped = false;
    ice = { at: Date.now(), servers: out.iceServers };
    return ice.servers;
  },
};

// can voice.js send a join through the broker at all? (capped still counts: the joiner gets voice_cap_reached)
const usable = () => client.registered() && state.ok !== false;
// is voice really available (discovery features.voice)?
const available = () => usable() && !state.capped;
async function probe() {
  if (!client.registered()) return;
  ice = null;
  try { await R.iceServers(); } catch { /* state updated by rc */ }
  state.at = Date.now();
}
// voice quota for instance admins (PROTOCOL §19.4): refreshed from Velora every 10 minutes while registered, pushed to admins on every change
let quotaTimer = null, QUOTA_MS = 10 * 60 * 1000;
async function refreshQuota() {
  if (!client.registered()) return null;
  try { client.setVoice(await client.call('GET', '/bonfire/relay/rtc/usage')); } catch { /* next round */ }
  return client.voiceQuota();
}
let lastQuota = '';
const onVoice = q => {
  const fp = JSON.stringify(q);
  if (!q || fp === lastQuota) return;
  lastQuota = fp;
  try { require('../gateway').pushToAdmins({ type: 'instance_update', settings: config.publicView(), voice_quota: q }); } catch { /* gateway not up */ }
};
const onRegistered = () => { state = { ok: null, capped: false, at: 0 }; probe(); refreshQuota(); };
function start() {
  client.events.on('registered', onRegistered);
  client.events.on('voice', onVoice);
  quotaTimer = setInterval(refreshQuota, QUOTA_MS); quotaTimer.unref?.();
  reprobe = setInterval(() => { if (state.ok === false || state.capped) probe(); }, 30 * 60 * 1000); reprobe.unref?.();
}
function stop() { clearInterval(hb); clearInterval(reprobe); clearInterval(quotaTimer); hb = reprobe = quotaTimer = null; lastQuota = ''; live.clear(); ice = null; state = { ok: null, capped: false, at: 0 }; }

module.exports = { R, usable, available, probe, start, stop, live, _setHeartbeatMs: ms => { HB_MS = ms; }, _setQuotaMs: ms => { QUOTA_MS = ms; }, refreshQuota, _state: () => state };
