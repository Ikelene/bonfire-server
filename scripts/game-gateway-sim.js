#!/usr/bin/env node
// Bonfire Link gateway simulator: pretends to be a Minecraft server (Paper / Fabric / Velocity) talking to a
// bonfire-server instance's game gateway (PROTOCOL §18), the way the plugin does after `bonfire server <url>`.
// Node 22+ (uses the built-in WebSocket), no dependencies. Copied from Velora's scripts/game-gateway-sim.js.
//
// As a library:   const { SimServer } = require('./game-gateway-sim');
// As a CLI:       node game-gateway-sim.js --url http://localhost:4100 --key sim-key.pem
//                 (--url takes the instance URL like `bonfire server <url>` does, or a full ws(s)://.../game-gateway URL)
//                 then type:  chat <name> <text> | event <kind> <name> [text] | cmd <command> | rcon <command>
//                             link <CODE> | unlink | status | log <text> | stop | quit
//                 --vectors <file>  checks the identity math against mc-bonfire/test-vectors.json and exits
const crypto = require('crypto');
const fs = require('fs');

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function identity(spkiDer) {
  const h = crypto.createHash('sha256').update(spkiDer).digest();
  const n = h.readUInt32BE(8) >>> 2;
  let t = '';
  for (let i = 5; i >= 0; i--) t += CROCKFORD[(n >>> (i * 5)) & 31];
  return { iid: 'g' + h.toString('hex').slice(0, 16), tag: `${t.slice(0, 3)}-${t.slice(3)}` };
}
// a keypair: from a PEM file (made on first use), a 32-byte seed, or fresh
function keypair({ keyFile, seed } = {}) {
  let priv;
  if (seed) priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  else if (keyFile && fs.existsSync(keyFile)) priv = crypto.createPrivateKey(fs.readFileSync(keyFile));
  else {
    priv = crypto.generateKeyPairSync('ed25519').privateKey;
    if (keyFile) fs.writeFileSync(keyFile, priv.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  }
  const spki = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' });
  return { priv, spki, ...identity(spki) };
}
// a tiny valid PNG (solid colour, w x h) for the icon op
function png(w = 16, h = 16, rgb = [98, 180, 122]) {
  const crc = buf => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const b of buf) x = t[(x ^ b) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2]; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', require('zlib').deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// what `bonfire server <url>` does with the URL: http(s)://host -> ws(s)://host/game-gateway?v=1 (a full ws(s) URL is kept)
function gatewayUrl(u) {
  const x = new URL(String(u));
  if (x.protocol === 'http:' || x.protocol === 'https:') { x.protocol = x.protocol === 'https:' ? 'wss:' : 'ws:'; x.pathname = '/game-gateway'; x.search = '?v=1'; }
  if (!x.searchParams.has('v')) x.searchParams.set('v', '1');
  return x.href;
}

class SimServer {
  constructor(o = {}) {
    this.o = { url: 'ws://127.0.0.1:4100/game-gateway?v=1', platform: 'paper', software: 'Paper 1.21.11-67 (sim)', mc_version: '1.21.11', mod_version: '1.0.0-sim',
      listing: 'public', motd: [{ text: 'Bonfire Link ', color: '#ff7ac6' }, { text: 'simulator', color: '#62b47a', b: true }], max_players: 20, public_address: 'sim.example.net',
      features: { chat: true, events: true, console: true, console_exec: true }, icon: png(), log: false, ...o };
    this.o.url = gatewayUrl(this.o.url);
    this.key = keypair({ keyFile: this.o.keyFile, seed: this.o.seed });
    this.iid = this.key.iid; this.tag = this.key.tag;
    this.frames = [];          // every frame received
    this.waiters = [];
    this.seq = 0; this.reqId = 0;
    this.players = new Map(o.players ? o.players.map(p => [p.uuid, p]) : []);
    this.flags = null; this.ready = null; this.closed = null;
    this.onExec = o.onExec || (cmd => ({ ok: true, output: [`(sim) ran: ${cmd}`] }));
  }
  log(...a) { if (this.o.log) console.log(`[sim ${this.tag}]`, ...a); }
  connect() {
    return new Promise((resolve, reject) => {
      const sock = new WebSocket(this.o.url);
      this.sock = sock;
      this.closed = null;
      sock.onmessage = ev => this._onFrame(JSON.parse(String(ev.data)));
      sock.onclose = ev => {
        this.closed = { code: ev.code, reason: ev.reason };
        clearInterval(this.hb); clearInterval(this.st);
        this.log('closed', ev.code, ev.reason);
        this.waiters.splice(0).forEach(w => w.reject?.(Object.assign(new Error(`closed ${ev.code} ${ev.reason}`), { code: ev.code })));
        reject(Object.assign(new Error(`closed ${ev.code} ${ev.reason}`), { code: ev.code, reason: ev.reason }));
      };
      sock.onerror = () => {};
      this.wait('ready', 20000).then(d => resolve(d)).catch(reject);
    });
  }
  _onFrame(m) {
    this.frames.push(m);
    this.log('<-', m.op, JSON.stringify(m.d).slice(0, 200));
    const d = m.d || {};
    if (m.op === 'hello') {
      const sig = crypto.sign(null, Buffer.from(`bonfire-gw-v1|${d.nonce}|${this.iid}`, 'utf8'), this.key.priv).toString('base64');
      const iconSha = this.o.icon ? crypto.createHash('sha256').update(this.o.icon).digest('hex') : null;
      this.send('identify', { v: 1, key: this.key.spki.toString('base64'), sig, iid: this.iid, platform: this.o.platform, software: this.o.software, mc_version: this.o.mc_version,
        mod_version: this.o.mod_version, listing: this.o.listing, motd: this.o.motd, icon_sha256: iconSha, max_players: this.o.max_players, online_mode: true,
        public_address: this.o.public_address, features: this.o.features });
      this.hbMs = d.heartbeat_ms || 30000;
    }
    if (m.op === 'ready') {
      this.ready = d;
      this.flags = { relay: d.relay, console_stream: d.console_stream };
      if (d.icon_needed && this.o.icon) this.send('icon', { png: this.o.icon.toString('base64') });
      this.sendStatus();
      if (!this.o.silent) { // silent = no heartbeats / periodic status (tests the 3-minute staleness rule)
        this.hb = setInterval(() => this.send('heartbeat', { seq: ++this.seq }), this.o.heartbeatMs || this.hbMs);
        this.st = setInterval(() => this.sendStatus(), 60000);
      }
    }
    if (m.op === 'config') this.flags = d;
    if (m.op === 'console.exec') {
      Promise.resolve(this.onExec(d.command, d.by)).then(r => this.send('console.result', { req: d.req, ...r }));
    }
    for (const w of [...this.waiters]) {
      if (w.op === m.op && (!w.pred || w.pred(d, m))) { this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(m.id !== undefined ? { ...d, _id: m.id } : d); }
    }
  }
  wait(op, ms = 8000, pred) {
    return new Promise((resolve, reject) => {
      const w = { op, pred, resolve, reject };
      w.timer = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); reject(new Error(`timeout waiting for ${op}`)); }, ms);
      this.waiters.push(w);
    });
  }
  send(op, d, id) { if (this.sock?.readyState !== 1) return false; const f = { op, d }; if (id !== undefined) f.id = id; this.sock.send(JSON.stringify(f)); this.log('->', op, JSON.stringify(d).slice(0, 160)); return true; }
  raw(text) { this.sock.send(text); }
  status() {
    const list = [...this.players.values()];
    return { online: true, version: this.o.software, motd: this.o.motd, players: { online: list.length, max: this.o.max_players, list }, tps: 20, uptime_s: 1234, backends: this.o.backends };
  }
  sendStatus() { return this.send('status', this.status()); }
  join(p) { this.players.set(p.uuid, p); this.send('event', { kind: 'join', ...p }); this.sendStatus(); }
  leave(uuid) { const p = this.players.get(uuid); this.players.delete(uuid); if (p) this.send('event', { kind: 'leave', ...p }); this.sendStatus(); }
  chat(p, text) { return this.send('chat', { uuid: p.uuid, name: p.name, display: p.display, text, server: p.server, bedrock: !!p.bedrock }); }
  event(kind, d = {}) { return this.send('event', { kind, ...d }); }
  log_(lines) { return this.send('console.log', { lines: lines.map(msg => (typeof msg === 'string' ? { t: Date.now(), level: 'INFO', logger: 'Server', msg } : msg)) }); }
  localCommand(command, source = 'console') { return this.send('console.command', { t: Date.now(), source, by: source === 'rcon' ? 'RCON' : 'CONSOLE', command }); }
  async link(code) { const id = ++this.reqId; this.send('link', { code }, id); return this.wait('link_result', 8000, (d, m) => m.id === id); }
  unlink() { return this.send('unlink', {}); }
  stop() { this.send('event', { kind: 'server_stop' }); this.sock.close(1000); }
  close(code = 1000) { try { this.sock.close(code); } catch { /* gone */ } }
}

module.exports = { SimServer, keypair, identity, png, gatewayUrl };

// ── CLI ──
if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  if (opt('vectors')) {
    const v = JSON.parse(fs.readFileSync(opt('vectors'), 'utf8'));
    const k = keypair({ seed: Buffer.from(v.seed_hex, 'hex') });
    const sig = crypto.sign(null, Buffer.from(v.signed_string, 'utf8'), k.priv).toString('base64');
    const ok = { spki: k.spki.toString('base64') === v.spki_b64, iid: k.iid === v.iid, pairing_tag: k.tag === v.pairing_tag, signature: sig === v.sig_b64 };
    console.log(ok);
    process.exit(Object.values(ok).every(Boolean) ? 0 : 1);
  }
  const sim = new SimServer({ url: opt('url') || 'http://localhost:4100', keyFile: opt('key') || 'sim-key.pem', platform: opt('platform') || 'paper', listing: opt('listing') || 'public', log: true });
  console.log(`iid ${sim.iid}  pairing tag ${sim.tag}`);
  sim.connect().then(() => console.log('ready')).catch(e => console.log('connect failed', e.message));
  const nat = { uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', name: 'Notch', display: '[Admin] Notch' };
  require('readline').createInterface({ input: process.stdin }).on('line', async line => {
    const [cmd, ...rest] = line.trim().split(' ');
    if (cmd === 'chat') sim.chat({ ...nat, name: rest[0] || nat.name }, rest.slice(1).join(' ') || 'hello');
    else if (cmd === 'event') sim.event(rest[0], { ...nat, name: rest[1] || nat.name, text: rest.slice(2).join(' ') || undefined });
    else if (cmd === 'cmd' || cmd === 'rcon') sim.localCommand(rest.join(' '), cmd === 'rcon' ? 'rcon' : 'console');
    else if (cmd === 'link') console.log(await sim.link(rest[0]).catch(e => e.message));
    else if (cmd === 'unlink') sim.unlink();
    else if (cmd === 'status') sim.sendStatus();
    else if (cmd === 'log') sim.log_([rest.join(' ')]);
    else if (cmd === 'stop') sim.stop();
    else if (cmd === 'quit') process.exit(0);
  });
}
