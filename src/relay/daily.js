'use strict';
// Daily chat credits (PROTOCOL §12.4): the first message of the UTC day by a Velora principal asks Velora for the daily
// credit. Trusted instances only: Velora answers 403 not_trusted otherwise, and the instance stops asking.
const db = require('../db');
const gateway = require('../gateway');
const messages = require('../messages');
const C = require('../communities');
const client = require('./client');

const done = new Map(); // user id -> 'YYYY-MM-DD' (UTC) already asked today
const today = () => new Date().toISOString().slice(0, 10);
let off = null;

async function onPost(msg, ctx, meta) {
  if (meta.system || meta.webhook || meta.bridged || !meta.userId || !client.trusted()) return;
  const day = today();
  if (done.get(meta.userId) === day) return;
  const u = db.get("SELECT * FROM users WHERE id = ? AND kind = 'velora'", Number(meta.userId));
  if (!u?.velora_id) return;
  done.set(meta.userId, day);
  if (done.size > 50000) for (const [k, v] of done) if (v !== day) done.delete(k);
  let r;
  try { r = await client.call('POST', '/bonfire/relay/daily', { user_id: String(u.velora_id) }); } catch (e) {
    if (e.code === 'not_trusted') { client.setTrusted(false); return; }
    if (e.status === 429 || e.code === 'velora_unreachable' || e.status >= 500) done.delete(meta.userId); // try again on their next message
    return;
  }
  if (r?.status === 'claimed' && C.getSettings(u).daily_notice !== false) {
    gateway.pushToUser(u.id, { type: 'chat_ephemeral', server: ctx.c.sid, channel: ctx.ch.cid, kind: 'daily', amount: r.amount, body: `You claimed your daily chat credits (+${r.amount} credits).` });
  }
}

function start() { off = messages.onPost(onPost); }
function stop() { off?.(); off = null; done.clear(); }
module.exports = { start, stop, onPost };
