'use strict';
// READY connections only. Reads are immediate; community notifications settle for 2 s.
const HEARTBEAT_TIMEOUT = 41250 * 2.5;
class BotPresence {
  constructor(notify, debounce = 2000) {
    this.connections = new Map();
    this.pending = new Map();
    this.published = new Set();
    this.notify = notify;
    this.debounce = debounce;
  }
  status(id) { return this.connections.has(Number(id)) ? 'online' : 'offline'; }
  changed(id) {
    clearTimeout(this.pending.get(id));
    this.pending.delete(id);
    const online = this.connections.has(id);
    if (online === this.published.has(id)) return;
    const timer = setTimeout(() => {
      this.pending.delete(id);
      if (online) this.published.add(id); else this.published.delete(id);
      this.notify(id, online ? 'online' : 'offline');
    }, this.debounce);
    timer.unref();
    this.pending.set(id, timer);
  }
  add(g) {
    const id = Number(g.botId);
    const wasOnline = this.connections.has(id);
    if (!wasOnline) this.connections.set(id, new Set());
    this.connections.get(id).add(g);
    if (!wasOnline) this.changed(id);
  }
  remove(g) {
    const id = Number(g.botId), set = this.connections.get(id);
    if (!set?.delete(g)) return;
    if (!set.size) { this.connections.delete(id); this.changed(id); }
  }
  sweep(time = Date.now()) {
    for (const set of [...this.connections.values()]) for (const g of [...set]) {
      if (g.ws.readyState !== 1 || time - g.last > HEARTBEAT_TIMEOUT) {
        this.remove(g);
        g.dispose();
        g.ws.close(4009, 'heartbeat timeout');
        setTimeout(() => g.ws.terminate(), 500).unref();
      }
    }
  }
  clear() {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.connections.clear();
    this.published.clear();
  }
}
const presence = new BotPresence((id, status) => {
  const db = require('./db');
  if (!db.raw()) return;
  const u = require('./auth').userById(id);
  if (!u) return;
  for (const c of db.all('SELECT c.* FROM communities c JOIN members m ON m.community_id = c.id WHERE m.user_id = ?', id)) {
    require('./gateway').emit(c.id, { type: 'chat_presence', server: c.sid, user_id: u.principal, username: u.username, presence: status });
  }
});
module.exports = { BotPresence, HEARTBEAT_TIMEOUT, presence };
