'use strict';
// Communities: snapshot-based permission checks, views, servers, members, invites, join requests, channels, roles, emojis,
// per-user settings. Response shapes follow Velora's chat.js (PROTOCOL §6).
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const perms = require('./perms');
const auth = require('./auth');
const managed = require('./managed');
const gateway = require('./gateway');
const { P, ALL_PERMS, CHANNEL_BITS, EVERYONE_DEFAULT } = perms;
const { err, clean, randId, now } = require('./util');

const LIMITS = { joined: 100, channels: 60, members: 5000, roles: 100, emojis: 100 };
// `game` = a Bonfire Link (Minecraft) channel, src/game; a `logs` channel may also be a CloudLink bridge, src/bridge/cloudlink.js
const CHANNEL_TYPES = ['text', 'logs', 'roles', 'welcome', 'link', 'voice', 'starboard', 'game'];
const STAR_SKIP = ['starboard', 'voice', 'link', 'roles']; // channels a starboard can't watch
const identity = require('./identity');
const CHANNEL_ICONS = ['hash', 'megaphone', 'lock', 'message-circle', 'gamepad-2', 'music', 'image', 'code', 'bug', 'lightbulb', 'help-circle', 'star', 'heart', 'book-open', 'coffee', 'sparkles', 'trophy', 'video', 'palette', 'terminal', 'globe', 'bell', 'shield', 'rocket', 'scroll-text', 'smile', 'flame', 'zap', 'gift', 'pin'];
const inviteCode = () => crypto.randomBytes(8).toString('base64').replace(/[^a-z0-9]/gi, '').slice(0, 8).padEnd(8, 'x');
const instanceOrigin = () => config.publicUrl();
const userView = auth.userView;
const lc = s => String(s).replace(/[\\%_]/g, x => '\\' + x);

// ---------- snapshot: everything permission checks need for one community ----------
class Snap {
  constructor(c) {
    this.c = c;
    this.roles = db.all('SELECT * FROM roles WHERE community_id = ? ORDER BY is_default DESC, position, id', c.id);
    this.everyone = this.roles.find(r => r.is_default) || null;
    this.channels = db.all('SELECT * FROM channels WHERE community_id = ? ORDER BY position, id', c.id);
    this.ow = new Map();
    for (const o of db.all('SELECT cp.* FROM channel_perms cp JOIN channels ch ON ch.id = cp.channel_id WHERE ch.community_id = ?', c.id)) {
      if (!this.ow.has(o.channel_id)) this.ow.set(o.channel_id, new Map());
      this.ow.get(o.channel_id).set(o.role_id, { allow: o.allow, deny: o.deny });
    }
    this._mr = new Map(); this._mem = new Map();
  }
  isMember(uid) {
    uid = Number(uid);
    if (!this._mem.has(uid)) this._mem.set(uid, !!db.get('SELECT 1 FROM members WHERE community_id = ? AND user_id = ?', this.c.id, uid));
    return this._mem.get(uid);
  }
  roleIds(uid) {
    uid = Number(uid);
    if (!this._mr.has(uid)) this._mr.set(uid, new Set(db.all('SELECT role_id FROM member_roles WHERE community_id = ? AND user_id = ?', this.c.id, uid).map(r => r.role_id)));
    return this._mr.get(uid);
  }
  isOwner(uid) { return Number(this.c.owner_id) === Number(uid); }
  perms(uid) { return perms.basePerms({ isMember: this.isMember(uid), isOwner: this.isOwner(uid), roles: this.roles, roleIds: this.roleIds(uid) }); }
  chPerms(ch, uid) { return perms.channelPerms(this.perms(uid), { overwrites: this.ow.get(ch.id), everyoneId: this.everyone?.id, roleIds: this.roleIds(uid) }); }
  canView(ch, uid) {
    if (!ch || !this.isMember(uid)) return false;
    const g = perms.gameView(ch, this.perms(uid)); // Bonfire Link console / not-set-up channels
    return g !== null ? g : perms.canView(this.perms(uid), this.chPerms(ch, uid), true);
  }
  canPost(ch, uid) { return perms.canPost(ch, this.perms(uid), this.chPerms(ch, uid), this.isMember(uid)); }
  top(uid) { return perms.topPosition(this.roles, this.roleIds(uid), this.isOwner(uid)); }
  can(uid, bit) { return (this.perms(uid) & bit) === bit; }
  visible(uid) { return this.channels.filter(ch => this.canView(ch, uid)); }
  channel(id) { return this.channels.find(ch => ch.id === id); }
}
const snapOf = c => new Snap(c);
const snapById = id => { const c = db.get('SELECT * FROM communities WHERE id = ?', id); return c ? new Snap(c) : null; };

// ---------- lookups that throw API errors ----------
function findCommunity(sid) {
  const c = db.get('SELECT * FROM communities WHERE sid = ?', String(sid || '').trim());
  if (!c) throw err('server_not_found', 404);
  return c;
}
function memberCommunity(sid, me) {
  const c = findCommunity(sid);
  const snap = snapOf(c);
  if (!snap.isMember(me.id)) throw err('not_a_member', 403);
  return { c, snap };
}
function findChannel(cid, me) {
  const ch = db.get('SELECT * FROM channels WHERE cid = ?', String(cid || '').trim().replace(/^#/, ''));
  if (!ch) throw err('channel_not_found', 404);
  const c = db.get('SELECT * FROM communities WHERE id = ?', ch.community_id);
  const snap = snapOf(c);
  if (!snap.isMember(me.id)) throw err('not_a_member', 403);
  if (!snap.canView(ch, me.id)) throw err('channel_not_found', 404);
  return { ch, c, snap };
}
const userByPrincipalOrThrow = p => { const u = auth.userByPrincipal(decodeURIComponent(String(p || ''))); if (!u) throw err('user_not_found', 404); return u; };
const memberCount = id => db.get('SELECT COUNT(*) AS n FROM members WHERE community_id = ?', id).n;
// the plan's member cap (managed instances, PROTOCOL §19) counts people, not bots; the owner and instance admins can always join
const humanCount = id => db.get("SELECT COUNT(*) AS n FROM members m JOIN users u ON u.id = m.user_id WHERE m.community_id = ? AND u.kind <> 'bot'", id).n;
const assertRoomToJoin = (c, user) => {
  if (managed.limit('member_cap') === null) return;
  managed.assertCanJoin(humanCount(c.id), user.kind === 'bot' || auth.isAdmin(user) || Number(c.owner_id) === Number(user.id));
};
const categoriesOf = c => { try { const v = JSON.parse(c.categories || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const cfgOf = ch => { try { return JSON.parse(ch.config || '{}') || {}; } catch { return {}; } };
const setCategories = (c, cats) => { c.categories = JSON.stringify(cats); db.run('UPDATE communities SET categories = ? WHERE id = ?', c.categories, c.id); };

// ---------- views ----------
const roleView = r => ({
  rid: r.rid, name: r.name, color: r.color || null, icon: r.icon_url || null, position: r.position,
  permissions: Number(r.permissions), hoist: !!r.hoist, mentionable: !!r.mentionable, is_default: !!r.is_default,
});
function serverView(c, snap, me) {
  const isMember = !!(me && snap.isMember(me.id));
  const base = me ? snap.perms(me.id) : 0;
  const role = isMember ? perms.roleLabel(snap.isOwner(me.id), base) : null;
  return {
    sid: c.sid, name: c.name, description: c.description, icon: c.icon_url || null, banner: c.banner_url || null,
    is_default: false, discoverable: !!c.listed, member_count: memberCount(c.id), member_cap: managed.limit('member_cap'), read_only: managed.readOnly(),
    role, perms: me ? base : undefined, allow_accent: c.allow_accent !== 0,
    invite: role ? c.invite_code : undefined, // every member can invite people
    join_policy: c.join_policy, allow_signing: config.mode() === 'velora', // signing: always allowed in velora mode, never required
    allow_uploads: !!c.allow_uploads, upload_max_mb: Math.min(c.upload_max_mb, managed.limit('max_upload_mb') ?? Infinity), listed: !!c.listed, instance: instanceOrigin(),
  };
}
const starMin = cfg => Math.min(Math.max(Math.trunc(Number(cfg.min) || 3), 1), 100);
function publicConfig(ch, snap) {
  const cfg = cfgOf(ch);
  if (ch.type === 'voice') return { allow_call_in: !!cfg.allow_call_in, user_limit: Number(cfg.user_limit) || 0 };
  if (ch.type === 'link') return { url: cfg.url || '' };
  if (ch.type === 'roles') return { items: (cfg.items || []).filter(i => snap.roles.some(r => r.rid === i.rid)) };
  if (ch.type === 'welcome') return { allow_chat: !!cfg.allow_chat, join: cfg.join || [], leave: cfg.leave || [] };
  if (ch.type === 'starboard') return { watch: (cfg.watch || []).filter(cid => snap.channels.some(x => x.cid === cid)), min: starMin(cfg) };
  if (ch.type === 'logs') return require('./bridge/cloudlink').publicChannelConfig(ch); // {} = webhooks, or the CloudLink bridge settings
  if (ch.type === 'game') return require('./game/game').publicChannelConfig(ch); // Bonfire Link
  return {}; // text
}
function overwritesOf(snap, ch) {
  return [...(snap.ow.get(ch.id) || new Map())].map(([roleId, o]) => ({ rid: snap.roles.find(r => r.id === roleId)?.rid, allow: o.allow, deny: o.deny })).filter(x => x.rid);
}
const isPrivate = (snap, ch) => !!(snap.everyone && snap.ow.get(ch.id)?.get(snap.everyone.id)?.deny & P.VIEW);
function channelView(snap, ch) {
  const bridges = require('./bridge').channelTag(ch.id); // linked Discord / Fluxer channels
  return {
    cid: ch.cid, server: snap.c.sid, name: ch.name, topic: ch.topic, category: ch.category,
    position: ch.position, locked: !!ch.locked, icon: ch.icon || null, last_message_id: String(ch.last_message_id || 0),
    type: ch.type || 'text', config: publicConfig(ch, snap), bridged: bridges[0], bridges,
    private: isPrivate(snap, ch) || undefined, overwrites: overwritesOf(snap, ch),
  };
}
function memberView(snap, u) {
  const isOwner = snap.isOwner(u.id);
  const ids = snap.roleIds(u.id);
  return {
    ...userView(u), color: null, role: perms.roleLabel(isOwner, snap.perms(u.id)),
    roles: snap.roles.filter(r => ids.has(r.id)).map(r => r.rid), presence: null, joined_at: u.joined_at ?? undefined,
  };
}

function readState(userId, channelIds) {
  const out = new Map();
  if (!channelIds.length) return out;
  for (const r of db.raw().prepare(`SELECT channel_id, last_read_id FROM read_state WHERE user_id = ? AND channel_id IN (${db.inList(channelIds)})`).all(userId, ...channelIds)) out.set(r.channel_id, Number(r.last_read_id));
  return out;
}
// mentions of you (@you, a reply to you, @everyone/@here, your roles) waiting in each channel since you last read it
function mentionCounts(me, channelIds) {
  if (!channelIds.length) return new Map();
  const roleIds = db.all('SELECT role_id FROM member_roles WHERE user_id = ?', me.id).map(r => r.role_id);
  const roleSql = roleIds.map(() => ' OR instr(m.mention_roles, ?) > 0').join('');
  const rows = db.raw().prepare(
    `SELECT m.channel_id, COUNT(*) AS n FROM messages m
     LEFT JOIN messages r ON r.id = m.reply_to
     LEFT JOIN read_state rs ON rs.channel_id = m.channel_id AND rs.user_id = ?
     WHERE m.channel_id IN (${db.inList(channelIds)}) AND m.id > COALESCE(rs.last_read_id, 0) AND (m.user_id IS NULL OR m.user_id <> ?)
       AND (m.body LIKE ? ESCAPE '\\' OR r.user_id = ? OR m.mention_everyone > 0${roleSql}) GROUP BY m.channel_id`)
    .all(me.id, ...channelIds, me.id, `%@${lc(me.username)}%`, me.id, ...roleIds.map(id => `,${id},`));
  return new Map(rows.map(r => [r.channel_id, Number(r.n)]));
}

// ---------- servers ----------
const joinedCount = uid => db.get('SELECT COUNT(*) AS n FROM members WHERE user_id = ?', uid).n;
function myServers(me) {
  const mine = db.all('SELECT c.* FROM communities c JOIN members m ON m.community_id = c.id WHERE m.user_id = ? ORDER BY c.id', me.id);
  const snaps = mine.map(snapOf);
  const vis = new Map(snaps.map(s => [s.c.id, s.visible(me.id)]));
  const ids = [...vis.values()].flat().map(ch => ch.id);
  const read = readState(me.id, ids);
  const pings = mentionCounts(me, ids);
  const order = getSettings(me).server_order || [];
  const pos = s => { const i = order.indexOf(s.sid); return i < 0 ? 1e6 + s.id : i; };
  return snaps.sort((a, b) => pos(a.c) - pos(b.c)).map(snap => {
    const list = vis.get(snap.c.id);
    return {
      ...serverView(snap.c, snap, me),
      mentions: list.reduce((n, ch) => n + (pings.get(ch.id) || 0), 0),
      online: 0, // instances don't relay presence
      unread: list.some(ch => Number(ch.last_message_id) > (read.get(ch.id) ?? Number(ch.last_message_id))),
    };
  });
}
function serverDetail(sid, me) {
  const { c, snap } = memberCommunity(sid, me);
  const list = snap.visible(me.id);
  const read = readState(me.id, list.map(ch => ch.id));
  const pings = mentionCounts(me, list.map(ch => ch.id));
  return {
    server: serverView(c, snap, me),
    categories: categoriesOf(c),
    roles: snap.roles.map(roleView),
    voice: require('./voice').stateOf(snap.channels),
    channels: list.map(ch => ({
      ...channelView(snap, ch), unread: Number(ch.last_message_id) > (read.get(ch.id) ?? Number(ch.last_message_id)),
      last_read_id: String(read.get(ch.id) ?? ch.last_message_id ?? 0), mentions: pings.get(ch.id) || 0, can_post: snap.canPost(ch, me.id),
    })),
  };
}
const JOIN_POLICIES = ['open', 'request'];

// ---------- one community per instance (PROTOCOL §5a) ----------
// config.json is the source of truth for name / description / icon_url; the community row mirrors it.
const theCommunity = () => db.get('SELECT * FROM communities ORDER BY id LIMIT 1');
function assertMayCreate(me) {
  if (!auth.isAdmin(me)) throw err('forbidden', 403);
  if (theCommunity()) throw err('community_exists', 409);
}
// discovery: the one community, always (not gated on `listed`), or null while the instance is not set up
function discoveryCommunity() {
  const c = theCommunity();
  return c ? { sid: c.sid, name: c.name, icon_url: c.icon_url || null, description: c.description, member_count: memberCount(c.id), join_policy: c.join_policy } : null;
}
// community -> config.json (after the row is written)
function mirrorToConfig(c) {
  const v = config.get();
  const patch = {};
  if (v.name !== c.name) patch.name = c.name;
  if (v.description !== c.description) patch.description = c.description;
  if ((v.icon_url || null) !== (c.icon_url || null)) patch.icon_url = c.icon_url || null;
  if (!!v.listed !== !!c.listed) patch.listed = !!c.listed; // the Velora directory toggle (relay/directory.js)
  if (Object.keys(patch).length) config.update(patch);
}
// config.json -> community (boot, hand edits, PATCH /instance/settings)
function syncFromConfig() {
  try {
    const c = theCommunity();
    if (!c) return;
    const v = config.get();
    const set = {};
    if (c.name !== v.name) set.name = v.name;
    if (c.description !== v.description) set.description = v.description;
    if ((c.icon_url || null) !== (v.icon_url || null)) set.icon_url = v.icon_url || null;
    if (typeof v.listed === 'boolean' && !!c.listed !== v.listed) set.listed = v.listed ? 1 : 0; // only once config.json has the key
    if (!Object.keys(set).length) return;
    db.run(`UPDATE communities SET ${Object.keys(set).map(k => k + ' = ?').join(', ')} WHERE id = ?`, ...Object.values(set), c.id);
    Object.assign(c, set);
    gateway.emit(c.id, { type: 'chat_server_update', server: serverView(c, snapOf(c), null) });
  } catch (e) { console.error('[communities] syncing config.json failed:', e.message); }
}
config.events.on('change', syncFromConfig);

// opts.empty: caller builds channels/roles itself (import) and mirrors to config.json afterwards
// The community is always owned by the instance owner; an admin who creates it is added as a member.
function createCommunity(me, body = {}, opts = {}) {
  assertMayCreate(me);
  const owner = auth.ownerRow();
  if (!owner) throw err('instance_not_claimed', 409);
  const name = clean(body.name, 60);
  if (!name) throw err('name_required');
  const policy = body.join_policy === undefined ? 'request' : body.join_policy;
  if (!JOIN_POLICIES.includes(policy)) throw err('invalid_join_policy');
  const sid = randId('s');
  const t = now();
  const c = db.tx(() => {
    const r = db.run(
      'INSERT INTO communities (sid, name, description, owner_id, invite_code, join_policy, listed, created_at, categories) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      sid, name, clean(body.description, 300), owner.id, inviteCode(), policy, (body.listed ?? body.discoverable) ? 1 : 0, t, '[]');
    const id = r.lastInsertRowid;
    insertRole(id, { name: '@everyone', permissions: EVERYONE_DEFAULT, is_default: 1, position: 0 });
    for (const uid of new Set([owner.id, me.id])) db.run('INSERT INTO members (community_id, user_id, joined_at) VALUES (?, ?, ?)', id, uid, t);
    if (!opts.empty) {
      insertChannel(id, { name: 'general', category: 'Text channels', type: 'text' }, 0);
      insertChannel(id, { name: 'General', category: 'Voice channels', type: 'voice' }, 1);
      db.run('UPDATE communities SET categories = ? WHERE id = ?', JSON.stringify(['Text channels', 'Voice channels']), id);
    }
    return db.get('SELECT * FROM communities WHERE id = ?', id);
  });
  for (const uid of new Set([owner.id, me.id])) gateway.subscribe(uid, c.id);
  if (!opts.empty) mirrorToConfig(c);
  return c;
}
function insertRole(communityId, r) {
  const res = db.run('INSERT INTO roles (rid, community_id, name, color, icon_url, position, permissions, hoist, mentionable, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    randId('r'), communityId, r.name, r.color || null, r.icon_url || null, r.position || 0, r.permissions || 0, r.hoist ? 1 : 0, r.mentionable ? 1 : 0, r.is_default ? 1 : 0);
  return db.get('SELECT * FROM roles WHERE id = ?', res.lastInsertRowid);
}
function insertChannel(communityId, b, position) {
  const type = CHANNEL_TYPES.includes(b.type) ? b.type : 'text';
  const res = db.run('INSERT INTO channels (cid, community_id, name, topic, category, position, locked, icon, type, config, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    randId('c'), communityId, b.name, clean(b.topic, 300), b.category || '', position, type === 'voice' ? 0 : (b.locked ? 1 : 0), b.icon || null, type, JSON.stringify(b.config || {}), now());
  return db.get('SELECT * FROM channels WHERE id = ?', res.lastInsertRowid);
}

function updateServer(sid, me, body) {
  const { c, snap } = memberCommunity(sid, me);
  if (!snap.can(me.id, P.MANAGE_SERVER)) throw err('not_allowed', 403);
  const set = {};
  if (body.allow_accent !== undefined) set.allow_accent = body.allow_accent ? 1 : 0;
  if (body.name !== undefined) { set.name = clean(body.name, 60); if (!set.name) throw err('name_required'); }
  if (body.description !== undefined) set.description = clean(body.description, 300);
  const listed = body.listed ?? body.discoverable;
  if (listed !== undefined) set.listed = listed ? 1 : 0;
  if (body.icon_url !== undefined) {
    if (body.icon_url !== null && (typeof body.icon_url !== 'string' || body.icon_url.length >= 512)) throw err('invalid_icon_url');
    set.icon_url = body.icon_url || null;
  }
  if (body.banner_url !== undefined) set.banner_url = body.banner_url || null;
  if (body.new_invite) set.invite_code = inviteCode();
  if (body.join_policy !== undefined) { if (!JOIN_POLICIES.includes(body.join_policy)) throw err('invalid_join_policy'); set.join_policy = body.join_policy; }
  if (body.allow_uploads !== undefined) set.allow_uploads = body.allow_uploads ? 1 : 0;
  if (body.upload_max_mb !== undefined) { const n = Number(body.upload_max_mb); if (!Number.isInteger(n) || n < 1 || n > 500) throw err('invalid_upload_max_mb'); set.upload_max_mb = Math.min(n, managed.limit('max_upload_mb') ?? n); }
  if (Object.keys(set).length) {
    db.run(`UPDATE communities SET ${Object.keys(set).map(k => k + ' = ?').join(', ')} WHERE id = ?`, ...Object.values(set), c.id);
    Object.assign(c, set);
    gateway.emit(c.id, { type: 'chat_server_update', server: serverView(c, snap, null) });
    if ('name' in set || 'description' in set || 'icon_url' in set || 'listed' in set) mirrorToConfig(c); // instance settings are the same values
  }
  return serverView(c, snap, me);
}
function deleteCommunity(sid, me) {
  const c = findCommunity(sid);
  const snap = snapOf(c);
  if (!snap.isOwner(me.id) && !auth.isAdmin(me)) throw err(snap.isMember(me.id) ? 'owner_only' : 'not_a_member', 403);
  gateway.emit(c.id, { type: 'chat_server_removed', server: c.sid, reason: 'deleted' });
  const files = [...db.all('SELECT file FROM emojis WHERE community_id = ?', c.id), ...db.all('SELECT file FROM sounds WHERE community_id = ?', c.id)];
  db.run('DELETE FROM communities WHERE id = ?', c.id);
  gateway.dropCommunity(c.id);
  require('./uploads').removeFiles(files.map(f => f.file));
  return c;
}

// ---------- members ----------
function addMember(c, userId, { quiet = false, announce = true } = {}) {
  userId = Number(userId);
  if (db.get('SELECT 1 FROM members WHERE community_id = ? AND user_id = ?', c.id, userId)) return false;
  db.tx(() => {
    db.run('INSERT OR IGNORE INTO members (community_id, user_id, joined_at) VALUES (?, ?, ?)', c.id, userId, now());
    db.run('DELETE FROM join_requests WHERE community_id = ? AND user_id = ?', c.id, userId);
    // start with everything read (a new member doesn't get years of "unread")
    for (const ch of db.all('SELECT id, last_message_id FROM channels WHERE community_id = ?', c.id)) db.run('INSERT OR REPLACE INTO read_state (user_id, channel_id, last_read_id) VALUES (?, ?, ?)', userId, ch.id, ch.last_message_id || 0);
  });
  gateway.subscribe(userId, c.id);
  const u = auth.userById(userId);
  if (announce && u) { const snap = snapOf(c); gateway.pushToUser(userId, { type: 'chat_server_added', server: serverView(c, snap, u) }); }
  if (!quiet) memberChanged(c, userId, 'joined');
  return true;
}
function memberChanged(c, userId, what) {
  const u = auth.userById(userId);
  const snap = snapOf(c);
  gateway.emit(c.id, { type: 'chat_member_update', server: c.sid, user_id: u?.principal || String(userId), username: u?.username, member: u ? memberView(snap, u) : null, change: what, member_count: memberCount(c.id) });
  if (what === 'joined' || what === 'left') { try { welcomeMessage(c, userId, what); } catch (e) { console.error('[communities] welcome', e.message); } }
}
// join / leave notices in every "welcome" channel
function welcomeMessage(c, userId, what) {
  const snap = snapOf(c), list = snap.channels.filter(ch => ch.type === 'welcome');
  const u = list.length && auth.userById(userId);
  if (!u) return;
  for (const ch of list) {
    const cfg = cfgOf(ch), own = what === 'joined' ? cfg.join : cfg.leave;
    const pool = own?.length ? own : what === 'joined' ? identity.DEFAULT_JOIN : identity.DEFAULT_LEAVE;
    const parts = identity.partsFor(pool[Math.floor(Math.random() * pool.length)], { server: c.name, count: memberCount(c.id) });
    require('./messages').systemMessage({ ch, c, snap }, identity.renderParts(parts, u.username), { sysKind: what === 'joined' ? 'join' : 'leave', subjectId: u.id, subjectParts: parts });
  }
}
function removeMember(c, userId, why) {
  userId = Number(userId);
  db.tx(() => {
    db.run('DELETE FROM members WHERE community_id = ? AND user_id = ?', c.id, userId);
    db.run('DELETE FROM member_roles WHERE community_id = ? AND user_id = ?', c.id, userId);
  });
  gateway.pushToUser(userId, { type: 'chat_server_removed', server: c.sid, reason: why });
  gateway.unsubscribe(userId, c.id);
  memberChanged(c, userId, why);
}
function leaveServer(sid, me) {
  const { c, snap } = memberCommunity(sid, me);
  if (snap.isOwner(me.id)) throw err('owner_cannot_leave', 400); // delete it instead
  removeMember(c, me.id, 'left');
}
function memberList(sid, me) {
  const { c, snap } = memberCommunity(sid, me);
  const users = db.all('SELECT u.*, m.joined_at FROM users u JOIN members m ON m.user_id = u.id WHERE m.community_id = ? ORDER BY u.id', c.id);
  return { server: c.sid, members: users.map(u => memberView(snap, u)) };
}
function moderateMember(sid, me, targetPrincipal, action) {
  const { c, snap } = memberCommunity(sid, me);
  const t = userByPrincipalOrThrow(targetPrincipal);
  const need = action === 'kick' ? P.KICK : P.BAN;
  if (!snap.can(me.id, need) || Number(t.id) === Number(me.id)) throw err('not_allowed', 403);
  const theirs = snap.isMember(t.id);
  if (theirs && snap.top(t.id) >= snap.top(me.id)) throw err('not_allowed', 403);
  if (action === 'unban') { db.run('DELETE FROM bans WHERE community_id = ? AND user_id = ?', c.id, t.id); return; }
  if (action === 'ban') {
    db.run('INSERT OR IGNORE INTO bans (community_id, user_id, banned_by, created_at) VALUES (?, ?, ?, ?)', c.id, t.id, me.id, now());
    db.run('DELETE FROM join_requests WHERE community_id = ? AND user_id = ?', c.id, t.id);
  }
  if (theirs) removeMember(c, t.id, action === 'ban' ? 'banned' : 'kicked');
}
function banList(sid, me) {
  const { c, snap } = memberCommunity(sid, me);
  if (!snap.can(me.id, P.BAN)) throw err('not_allowed', 403);
  return { bans: db.all('SELECT * FROM bans WHERE community_id = ? ORDER BY created_at DESC', c.id).map(b => ({ user: userView(auth.userById(b.user_id)), banned_by: userView(auth.userById(b.banned_by)), created_at: b.created_at })) };
}
// kept for client compatibility: the instance's one community (if any), regardless of `listed`
function discover(me) {
  const c = theCommunity();
  return c ? [{ ...serverView(c, snapOf(c), null), joined: snapOf(c).isMember(me.id) }] : [];
}

// ---------- invites + joining ----------
function findInvite(code) {
  code = String(code || '').trim();
  const inv = db.get('SELECT * FROM invites WHERE code = ?', code);
  if (inv) {
    const c = db.get('SELECT * FROM communities WHERE id = ?', inv.community_id);
    if ((inv.expires_at && inv.expires_at <= now()) || (inv.max_uses && inv.uses >= inv.max_uses)) throw err('invalid_invite', 404);
    return { c, inv };
  }
  const c = db.get('SELECT * FROM communities WHERE invite_code = ?', code); // legacy permanent code
  if (!c || !code) throw err('invalid_invite', 404);
  return { c, inv: null };
}
function inviteInfo(code) {
  const { c } = findInvite(code);
  return serverView(c, snapOf(c), null);
}
const inviteView = i => ({ code: i.code, created_by: userView(auth.userById(i.created_by))?.id || null, created_at: i.created_at, expires_at: i.expires_at ?? null, max_uses: i.max_uses ?? null, uses: i.uses });
function listInvites(sid, me) {
  const { c, snap } = memberCommunity(sid, me);
  if (!snap.can(me.id, P.MANAGE_SERVER)) throw err('not_allowed', 403);
  return { invites: db.all('SELECT * FROM invites WHERE community_id = ? ORDER BY created_at DESC', c.id).map(inviteView) };
}
function createInvite(sid, me, body = {}) {
  const { c, snap } = memberCommunity(sid, me);
  if (!snap.can(me.id, P.MANAGE_SERVER)) throw err('not_allowed', 403);
  let expires = null, max = null;
  if (body.expires_in !== undefined && body.expires_in !== null) { const s = Number(body.expires_in); if (!Number.isFinite(s) || s < 1 || s > 365 * 86400) throw err('invalid_expires_in'); expires = now() + Math.floor(s * 1000); }
  if (body.max_uses !== undefined && body.max_uses !== null) { const n = Number(body.max_uses); if (!Number.isInteger(n) || n < 1 || n > 100000) throw err('invalid_max_uses'); max = n; }
  if (db.get('SELECT COUNT(*) AS n FROM invites WHERE community_id = ?', c.id).n >= 200) throw err('too_many_invites');
  const code = inviteCode();
  db.run('INSERT INTO invites (code, community_id, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?)', code, c.id, me.id, now(), expires, max);
  return inviteView(db.get('SELECT * FROM invites WHERE code = ?', code));
}
function deleteInvite(code, me) {
  const inv = db.get('SELECT * FROM invites WHERE code = ?', String(code));
  if (!inv) throw err('invalid_invite', 404);
  const c = db.get('SELECT * FROM communities WHERE id = ?', inv.community_id);
  if (!snapOf(c).can(me.id, P.MANAGE_SERVER)) throw err('not_allowed', 403);
  db.run('DELETE FROM invites WHERE code = ?', inv.code);
}
function admit(c, me, inv) {
  if (memberCount(c.id) >= LIMITS.members) throw err('server_full');
  assertRoomToJoin(c, me);
  if (joinedCount(me.id) >= LIMITS.joined) throw err('too_many_joined');
  if (addMember(c, me.id) && inv) db.run('UPDATE invites SET uses = uses + 1 WHERE code = ?', inv.code);
}
// join by sid (follows join_policy) or by invite code (always admits)
function joinServer(sid, me, code, body = {}) {
  let c, inv = null;
  if (code) ({ c, inv } = findInvite(code)); else c = findCommunity(sid);
  const snap = snapOf(c);
  if (db.get('SELECT 1 FROM bans WHERE community_id = ? AND user_id = ?', c.id, me.id)) throw err('banned_from_server', 403);
  if (snap.isMember(me.id)) return { server: serverView(c, snap, me) };
  if (!code && c.join_policy === 'request') {
    assertRoomToJoin(c, me);
    if (!db.get('SELECT 1 FROM join_requests WHERE community_id = ? AND user_id = ?', c.id, me.id)) {
      const t = now(), message = clean(body?.message, 300);
      db.run('INSERT INTO join_requests (community_id, user_id, message, created_at) VALUES (?, ?, ?, ?)', c.id, me.id, message, t);
      gateway.emitWhere(c.id, { type: 'chat_join_request', sid: c.sid, request: { user: userView(me), message, created_at: t } }, uid => (snap.perms(uid) & (P.KICK | P.MANAGE_SERVER)) !== 0);
    }
    return { pending: true };
  }
  admit(c, me, inv);
  return { server: serverView(c, snapOf(c), me) };
}
function requestAccess(sid, me) {
  const { c, snap } = memberCommunity(sid, me);
  if (!snap.can(me.id, P.KICK) && !snap.can(me.id, P.MANAGE_SERVER)) throw err('not_allowed', 403);
  return { c, snap };
}
function listRequests(sid, me) {
  const { c } = requestAccess(sid, me);
  const rows = db.all('SELECT * FROM join_requests WHERE community_id = ? ORDER BY created_at', c.id);
  return { requests: rows.map(r => ({ user: userView(auth.userById(r.user_id)), message: r.message, created_at: r.created_at })) };
}
function resolveRequest(sid, me, targetPrincipal, accept) {
  const { c } = requestAccess(sid, me);
  const t = userByPrincipalOrThrow(targetPrincipal);
  if (!db.get('SELECT 1 FROM join_requests WHERE community_id = ? AND user_id = ?', c.id, t.id)) throw err('request_not_found', 404);
  if (accept) assertRoomToJoin(c, t);
  db.run('DELETE FROM join_requests WHERE community_id = ? AND user_id = ?', c.id, t.id);
  if (accept && !db.get('SELECT 1 FROM bans WHERE community_id = ? AND user_id = ?', c.id, t.id)) {
    if (memberCount(c.id) >= LIMITS.members) throw err('server_full');
    gateway.pushToUser(t.id, { type: 'chat_join_result', sid: c.sid, accepted: true });
    addMember(c, t.id);
  } else gateway.pushToUser(t.id, { type: 'chat_join_result', sid: c.sid, accepted: false });
}

// ---------- channels ----------
const channelName = n => String(n || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').replace(/-+/g, '-').slice(0, 40);
function channelIcon(v) {
  v = String(v || '').trim();
  if (!v) return null;
  if (CHANNEL_ICONS.includes(v)) return v;
  return v.startsWith(instanceOrigin() + '/uploads/') ? v.slice(0, 512) : null;
}
const templateList = v => (Array.isArray(v) ? v : []).map(t => clean(t, 200)).filter(t => t.includes('{user}')).slice(0, 20);
// what someone with Manage channels sent -> what gets stored (shop roles need Manage roles + to sit below you)
// current = the channel row being edited (null when creating)
function cleanConfig(type, raw, snap, me, current = null) {
  raw = raw && typeof raw === 'object' ? raw : {};
  if (type === 'logs') return require('./bridge/cloudlink').cleanChannelConfig(raw, snap, me, current); // webhooks (default) or a CloudLink bridge
  if (type === 'game') return require('./game/game').cleanChannelConfig(raw, snap, me, current); // Bonfire Link
  if (type === 'voice') return { allow_call_in: !!raw.allow_call_in, user_limit: Math.min(Math.max(Math.trunc(Number(raw.user_limit) || 0), 0), 99) };
  if (type === 'link') {
    const url = String(raw.url || '').trim().slice(0, 500);
    if (!/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(url)) throw err('bad_link');
    return { url };
  }
  if (type === 'welcome') return { allow_chat: !!raw.allow_chat, join: templateList(raw.join), leave: templateList(raw.leave) };
  if (type === 'starboard') {
    const watch = [...new Set((Array.isArray(raw.watch) ? raw.watch : []).map(String))].filter(cid => { const c = snap.channels.find(x => x.cid === cid); return c && !STAR_SKIP.includes(c.type); }).slice(0, 50);
    return { watch, min: starMin(raw) };
  }
  if (type === 'roles') {
    const mine = snap.top(me.id), items = [];
    for (const it of (Array.isArray(raw.items) ? raw.items : []).slice(0, 25)) {
      const r = snap.roles.find(x => x.rid === it?.rid);
      if (!r || r.is_default || items.some(x => x.rid === r.rid)) continue;
      if (Number(r.permissions) & P.ADMIN) throw err('shop_admin_role');
      if (r.position >= mine) throw err('role_too_high', 403);
      items.push({ rid: r.rid, price: Math.min(Math.max(Math.trunc(Number(it.price) || 0), 0), 1000000), desc: clean(it.desc, 200) });
    }
    if (items.length && !snap.can(me.id, P.MANAGE_ROLES)) throw err('not_allowed', 403);
    return { items };
  }
  return {}; // text
}
// onChannelsChanged(fn): fn(community) after any channel create / edit / delete / layout change (bridges, Bonfire Link)
const channelHooks = [];
const onChannelsChanged = fn => { channelHooks.push(fn); return () => { const i = channelHooks.indexOf(fn); if (i >= 0) channelHooks.splice(i, 1); }; };
function channelsChanged(c) {
  const snap = snapOf(c);
  gateway.emit(c.id, { type: 'chat_channels_update', server: c.sid, channels: snap.channels.map(ch => channelView(snap, ch)), categories: categoriesOf(c) });
  for (const fn of channelHooks) { try { fn(c); } catch (e) { console.error('[communities] channel hook', e.message); } }
}
function ensureCategory(c, cat) {
  const cats = categoriesOf(c);
  if (cat && !cats.includes(cat)) setCategories(c, [...cats, cat]);
}
function createChannel(sid, me, body = {}) {
  const { c, snap } = memberCommunity(sid, me);
  if (!snap.can(me.id, P.MANAGE_CHANNELS)) throw err('not_allowed', 403);
  if (snap.channels.length >= LIMITS.channels) throw err('too_many_channels');
  const name = channelName(body.name);
  if (!name) throw err('name_required');
  const type = CHANNEL_TYPES.includes(body.type) ? body.type : 'text';
  let cat = clean(body.category, 40) || categoriesOf(c)[0] || 'Text channels';
  ensureCategory(c, cat);
  const row = insertChannel(c.id, { name, topic: body.topic, category: cat, locked: !!body.locked, icon: channelIcon(body.icon), type, config: cleanConfig(type, body.config, snap, me) }, (snap.channels[snap.channels.length - 1]?.position ?? -1) + 1);
  const idrows = db.all('SELECT user_id FROM members WHERE community_id = ?', c.id);
  for (const m of idrows) db.run('INSERT OR IGNORE INTO read_state (user_id, channel_id, last_read_id) VALUES (?, ?, 0)', m.user_id, row.id);
  channelsChanged(c);
  const s2 = snapOf(c);
  return channelView(s2, s2.channel(row.id));
}
function updateChannel(cid, me, body = {}) {
  const { ch, c, snap } = findChannel(cid, me);
  if (!snap.can(me.id, P.MANAGE_CHANNELS)) throw err('not_allowed', 403);
  const set = {};
  if (body.icon !== undefined) set.icon = channelIcon(body.icon);
  if (body.name !== undefined) { set.name = channelName(body.name); if (!set.name) throw err('name_required'); }
  if (body.topic !== undefined) set.topic = clean(body.topic, 300);
  if (body.category !== undefined) {
    set.category = clean(body.category, 40);
    if (!set.category) throw err('category_required');
    ensureCategory(c, set.category);
  }
  if (body.locked !== undefined) set.locked = body.locked ? 1 : 0;
  if (body.type !== undefined && CHANNEL_TYPES.includes(body.type)) set.type = body.type;
  const type = set.type || ch.type;
  if (body.type !== undefined || body.config !== undefined) set.config = JSON.stringify(cleanConfig(type, body.config ?? (type === ch.type ? cfgOf(ch) : {}), snap, me, ch));
  if (type === 'voice') set.locked = 0;
  if (body.position !== undefined && Number.isFinite(Number(body.position))) set.position = Math.trunc(Number(body.position));
  if (Object.keys(set).length) {
    db.run(`UPDATE channels SET ${Object.keys(set).map(k => k + ' = ?').join(', ')} WHERE id = ?`, ...Object.values(set), ch.id);
    channelsChanged(c);
  }
  const s2 = snapOf(c);
  return channelView(s2, s2.channel(ch.id));
}
function deleteChannel(cid, me) {
  const { ch, c, snap } = findChannel(cid, me);
  if (!snap.can(me.id, P.MANAGE_CHANNELS)) throw err('not_allowed', 403);
  if (snap.channels.length <= 1) throw err('last_channel');
  db.run('DELETE FROM channels WHERE id = ?', ch.id);
  channelsChanged(c);
}
// Manage channels: [{ rid, allow, deny }] (see / send / attach)
function setChannelPerms(cid, me, list) {
  const { ch, c, snap } = findChannel(cid, me);
  if (!snap.can(me.id, P.MANAGE_CHANNELS)) throw err('not_allowed', 403);
  const rows = (Array.isArray(list) ? list : []).slice(0, 100).map(x => ({ role: snap.roles.find(r => r.rid === String(x?.rid || '')), allow: (Number(x?.allow) || 0) & CHANNEL_BITS, deny: (Number(x?.deny) || 0) & CHANNEL_BITS }))
    .filter(x => x.role && (x.allow || x.deny));
  db.tx(() => {
    db.run('DELETE FROM channel_perms WHERE channel_id = ?', ch.id);
    for (const x of rows) db.run('INSERT OR REPLACE INTO channel_perms (channel_id, role_id, allow, deny) VALUES (?, ?, ?, ?)', ch.id, x.role.id, x.allow & ~x.deny, x.deny);
  });
  channelsChanged(c);
  gateway.emit(c.id, { type: 'chat_perms_changed', server: c.sid });
  const s2 = snapOf(c);
  return channelView(s2, s2.channel(ch.id));
}
// the sidebar layout: category order + which category each channel is in and its place (Manage channels)
function setLayout(sid, me, body = {}) {
  const { c, snap } = memberCommunity(sid, me);
  if (!snap.can(me.id, P.MANAGE_CHANNELS)) throw err('not_allowed', 403);
  const old = categoriesOf(c);
  const cats = [...new Set((Array.isArray(body.categories) ? body.categories : old).map(x => clean(x, 40)).filter(Boolean))].slice(0, 30);
  if (!cats.length && snap.channels.length) throw err('need_a_category');
  const home = cat => { // a deleted category's channels move to the one above it (else the next one)
    if (cats.includes(cat)) return cat;
    const i = old.indexOf(cat);
    for (let j = i - 1; j >= 0; j--) if (cats.includes(old[j])) return old[j];
    for (let j = i + 1; j < old.length; j++) if (cats.includes(old[j])) return old[j];
    return cats[0];
  };
  db.tx(() => {
    setCategories(c, cats);
    if (Array.isArray(body.channels)) {
      let pos = 0;
      for (const x of body.channels.slice(0, LIMITS.channels)) {
        const ch = snap.channels.find(k => k.cid === String(x?.cid || ''));
        if (!ch) continue;
        const wanted = clean(x.category, 40);
        db.run('UPDATE channels SET category = ?, position = ? WHERE id = ?', cats.includes(wanted) ? wanted : home(ch.category), pos++, ch.id);
      }
    }
    for (const ch of db.all('SELECT * FROM channels WHERE community_id = ?', c.id)) if (!cats.includes(ch.category)) db.run('UPDATE channels SET category = ? WHERE id = ?', home(ch.category), ch.id);
  });
  channelsChanged(c);
  const s2 = snapOf(c);
  return { categories: cats, channels: s2.channels.map(ch => channelView(s2, ch)) };
}

// ---------- roles (Manage roles; you can only touch roles below your own highest one) ----------
const roleColor = v => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : null);
function findRole(snap, rid) {
  const r = snap.roles.find(x => x.rid === String(rid));
  if (!r) throw err('role_not_found', 404);
  return r;
}
function roleAccess(snap, me, role) {
  if (!snap.can(me.id, P.MANAGE_ROLES)) throw err('not_allowed', 403);
  if (role && !perms.canManageRole(snap.perms(me.id), snap.top(me.id), role)) throw err('role_too_high', 403);
}
function rolesChanged(c) {
  gateway.emit(c.id, { type: 'chat_roles_update', server: c.sid, roles: snapOf(c).roles.map(roleView) });
}
function createRole(sid, me, body = {}) {
  const { c, snap } = memberCommunity(sid, me);
  roleAccess(snap, me, null);
  if (snap.roles.length >= LIMITS.roles) throw err('too_many_roles');
  const mine = snap.perms(me.id), top = snap.top(me.id);
  // new roles go just under yours (or on top, for the owner)
  const pos = top === Infinity ? Math.max(0, ...snap.roles.map(r => r.position)) + 1 : Math.max(1, top);
  const row = db.tx(() => {
    db.run('UPDATE roles SET position = position + 1 WHERE community_id = ? AND is_default = 0 AND position >= ?', c.id, pos);
    return insertRole(c.id, { name: clean(body.name, 40) || 'new role', color: roleColor(body.color), position: pos, permissions: perms.grantable(body.permissions, mine), hoist: !!body.hoist, mentionable: !!body.mentionable });
  });
  rolesChanged(c);
  return roleView(row);
}
function updateRole(sid, me, rid, body = {}) {
  const { c, snap } = memberCommunity(sid, me);
  const r = findRole(snap, rid);
  roleAccess(snap, me, r);
  const mine = snap.perms(me.id), set = {};
  if (!r.is_default) {
    if (body.name !== undefined) { set.name = clean(body.name, 40); if (!set.name) throw err('name_required'); }
    if (body.color !== undefined) set.color = roleColor(body.color);
    if (body.icon_url !== undefined) set.icon_url = body.icon_url || null;
    if (body.hoist !== undefined) set.hoist = body.hoist ? 1 : 0;
    if (body.mentionable !== undefined) set.mentionable = body.mentionable ? 1 : 0;
  }
  if (body.permissions !== undefined) set.permissions = perms.grantable(body.permissions, mine, r.permissions);
  if (Object.keys(set).length) {
    db.run(`UPDATE roles SET ${Object.keys(set).map(k => k + ' = ?').join(', ')} WHERE id = ?`, ...Object.values(set), r.id);
    rolesChanged(c);
    gateway.emit(c.id, { type: 'chat_perms_changed', server: c.sid });
  }
  return roleView(db.get('SELECT * FROM roles WHERE id = ?', r.id));
}
function deleteRole(sid, me, rid) {
  const { c, snap } = memberCommunity(sid, me);
  const r = findRole(snap, rid);
  if (r.is_default) throw err('not_allowed', 403);
  roleAccess(snap, me, r);
  db.run('DELETE FROM roles WHERE id = ?', r.id);
  rolesChanged(c);
  gateway.emit(c.id, { type: 'chat_members_stale', server: c.sid });
  gateway.emit(c.id, { type: 'chat_perms_changed', server: c.sid });
}
// order: role ids top to bottom (only the ones below you can move)
function orderRoles(sid, me, order) {
  const { c, snap } = memberCommunity(sid, me);
  roleAccess(snap, me, null);
  const top = snap.top(me.id);
  const list = (Array.isArray(order) ? order : []).map(x => snap.roles.find(r => r.rid === x)).filter(r => r && !r.is_default);
  const movable = list.filter(r => r.position < top);
  const slots = movable.map(r => r.position).sort((a, b) => b - a); // reuse their places, highest first
  db.tx(() => movable.forEach((r, i) => db.run('UPDATE roles SET position = ? WHERE id = ?', slots[i], r.id)));
  rolesChanged(c);
  return snapOf(c).roles.map(roleView);
}
function setMemberRole(sid, me, targetPrincipal, rid, on) {
  const { c, snap } = memberCommunity(sid, me);
  const r = findRole(snap, rid);
  if (r.is_default) throw err('not_allowed', 403);
  roleAccess(snap, me, r);
  const t = userByPrincipalOrThrow(targetPrincipal);
  if (!snap.isMember(t.id)) throw err('not_a_member', 404);
  if (Number(t.id) !== Number(me.id) && snap.top(t.id) >= snap.top(me.id)) throw err('not_allowed', 403);
  if (on) db.run('INSERT OR IGNORE INTO member_roles (community_id, user_id, role_id) VALUES (?, ?, ?)', c.id, t.id, r.id);
  else db.run('DELETE FROM member_roles WHERE community_id = ? AND user_id = ? AND role_id = ?', c.id, t.id, r.id);
  memberChanged(c, t.id, 'role');
  gateway.pushToUser(t.id, { type: 'chat_perms_changed', server: c.sid }); // their own permissions changed
}
const setRoleIcon = (sid, me, rid, url) => updateRole(sid, me, rid, { icon_url: url });

// ---------- emojis (Manage server; usable anywhere) ----------
const emojiName = n => String(n || '').replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 32);
const emojiView = e => ({ eid: e.eid, name: e.name, animated: !!e.animated, url: `${instanceOrigin()}/uploads/${e.file}` });
function emojiCommunity(sid, me, needManage) {
  const r = memberCommunity(sid, me);
  if (needManage && !r.snap.can(me.id, P.MANAGE_SERVER)) throw err('not_allowed', 403);
  return r;
}
function emojisChanged(c) {
  gateway.emit(c.id, { type: 'chat_emojis_update', server: c.sid, emojis: db.all('SELECT * FROM emojis WHERE community_id = ? ORDER BY id', c.id).map(emojiView) });
}
function listEmojis(sid, me) {
  const { c } = emojiCommunity(sid, me, false);
  return { emojis: db.all('SELECT * FROM emojis WHERE community_id = ? ORDER BY id', c.id).map(emojiView), max: managed.limit('emojis') ?? LIMITS.emojis };
}
function allEmojis(me) {
  const out = [];
  for (const c of db.all('SELECT c.* FROM communities c JOIN members m ON m.community_id = c.id WHERE m.user_id = ? ORDER BY c.id', me.id)) {
    const emojis = db.all('SELECT * FROM emojis WHERE community_id = ? ORDER BY id', c.id).map(emojiView);
    if (emojis.length) out.push({ sid: c.sid, name: c.name, icon: c.icon_url || null, emojis });
  }
  return { servers: out };
}
function createEmoji(sid, me, { buffer, name, filename }) {
  const { c } = emojiCommunity(sid, me, true);
  if (!buffer) throw err('no_file');
  const have = db.get('SELECT COUNT(*) AS n FROM emojis WHERE community_id = ?', c.id).n;
  managed.assertRoom('emojis', have);
  if (have >= LIMITS.emojis) throw err('too_many_emojis');
  const up = require('./uploads');
  const eid = 'e' + require('./util').randHex(5);
  const { file, animated } = up.saveEmoji(buffer, eid);
  const nm = emojiName(name) || emojiName(String(filename || '').replace(/\.[^.]+$/, '')) || 'emoji';
  db.run('INSERT INTO emojis (eid, community_id, name, animated, file, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', eid, c.id, nm, animated ? 1 : 0, file, me.id, now());
  emojisChanged(c);
  return { emoji: emojiView({ eid, name: nm, animated, file }) };
}
function renameEmoji(sid, me, eid, name) {
  const { c } = emojiCommunity(sid, me, true);
  const nm = emojiName(name);
  if (!nm) throw err('name_required');
  db.run('UPDATE emojis SET name = ? WHERE eid = ? AND community_id = ?', nm, eid, c.id);
  emojisChanged(c);
}
function deleteEmoji(sid, me, eid) {
  const { c } = emojiCommunity(sid, me, true);
  const e = db.get('SELECT * FROM emojis WHERE eid = ? AND community_id = ?', eid, c.id);
  if (!e) throw err('not_found', 404);
  db.run('DELETE FROM emojis WHERE id = ?', e.id);
  require('./uploads').removeFiles([e.file]);
  emojisChanged(c);
}

// click an emoji: which community it is from
function emojiInfo(eid, me) {
  const e = db.get('SELECT e.eid, e.name, e.animated, e.community_id FROM emojis e WHERE e.eid = ?', String(eid));
  if (!e) throw err('not_found', 404);
  const c = db.get('SELECT * FROM communities WHERE id = ?', e.community_id);
  const joined = snapOf(c).isMember(me.id);
  const open = joined || !!c.listed;
  return { emoji: { eid: e.eid, name: e.name, animated: !!e.animated }, server: open ? { sid: c.sid, name: c.name, icon: c.icon_url || null, discoverable: !!c.listed, joined, member_count: memberCount(c.id) } : null };
}

// ---------- roles shop (self-assign roles; priced ones are paid through Velora, see relay/shop.js) ----------
function shopChannel(cid, me) {
  const r = findChannel(cid, me);
  if (r.ch.type !== 'roles') throw err('not_a_shop');
  return r;
}
function shopView(cid, me) {
  const { ch, snap } = shopChannel(cid, me);
  const mine = snap.roleIds(me.id);
  const bought = new Set(db.all('SELECT role_id FROM role_purchases WHERE community_id = ? AND user_id = ?', snap.c.id, me.id).map(b => b.role_id)); // paid through Velora (relay/shop.js)
  const items = (cfgOf(ch).items || []).map(it => {
    const r = snap.roles.find(x => x.rid === it.rid);
    return r && { role: roleView(r), price: it.price || 0, desc: it.desc || '', has: mine.has(r.id), owned: !it.price || snap.isOwner(me.id) || bought.has(r.id) };
  }).filter(Boolean);
  return { items, balance: null, owner_free: snap.isOwner(me.id) };
}
function shopRole(cid, me, rid, on) {
  const { ch, c, snap } = shopChannel(cid, me);
  const item = (cfgOf(ch).items || []).find(i => i.rid === rid);
  const r = item && snap.roles.find(x => x.rid === item.rid);
  if (!r) throw err('role_not_found', 404);
  if (on) {
    if (Number(r.permissions) & P.ADMIN) throw err('shop_admin_role');
    if (!snap.roleIds(me.id).has(r.id)) {
      // priced roles are paid through Velora first (relay/shop.js buy); once bought they go on and off for free
      if ((Number(item.price) || 0) > 0 && !snap.isOwner(me.id) && !db.get('SELECT 1 FROM role_purchases WHERE community_id = ? AND user_id = ? AND role_id = ?', c.id, me.id, r.id)) throw err('payment_unavailable', 402);
      db.run('INSERT OR IGNORE INTO member_roles (community_id, user_id, role_id) VALUES (?, ?, ?)', c.id, me.id, r.id);
    }
  } else db.run('DELETE FROM member_roles WHERE community_id = ? AND user_id = ? AND role_id = ?', c.id, me.id, r.id);
  memberChanged(c, me.id, 'role');
  gateway.pushToUser(me.id, { type: 'chat_perms_changed', server: c.sid });
  return shopView(cid, me);
}

// ---------- identities, per-user settings, notification prefs ----------
function identities(idsParam) {
  const ids = [...new Set(String(idsParam || '').split(',').map(s => s.trim()).filter(Boolean))];
  if (!ids.length || ids.length > 200 || ids.some(x => !/^[vlb]:[0-9]{1,20}$/.test(x))) throw err('invalid_user_ids');
  return { users: ids.map(id => userView(auth.userByPrincipal(id)) || { id, username: null }) };
}
const SETTING_DEFAULTS = {
  show_typing: true, share_typing: true, sounds: true, notify_sound: 'short', notifications: 'mentions', compact: false, animations: true,
  link_images: true, server_order: [], developer_mode: false, allow_vc_calls: true,
};
const SETTING_CHOICES = { notify_sound: ['short', 'long', 'classic'], notifications: ['all', 'mentions', 'none'] };
function validSetting(k, v) {
  if (!/^[a-z0-9_]{1,40}$/.test(k)) return false;
  if (k === 'server_order') return Array.isArray(v) && v.length <= 200 && v.every(x => /^s[0-9a-f]{10}$/.test(String(x)));
  if (SETTING_CHOICES[k]) return SETTING_CHOICES[k].includes(v);
  if (k in SETTING_DEFAULTS) return typeof v === typeof SETTING_DEFAULTS[k];
  return v === null || ['string', 'number', 'boolean'].includes(typeof v) ? (typeof v !== 'string' || v.length <= 500) : false; // other keys: small scalars only
}
function getSettings(me) {
  let saved = {};
  try { saved = JSON.parse(db.get('SELECT settings FROM users WHERE id = ?', me.id)?.settings || '{}') || {}; } catch { saved = {}; }
  const s = { ...SETTING_DEFAULTS };
  for (const [k, v] of Object.entries(saved)) if (validSetting(k, v)) s[k] = v;
  return s;
}
function setSettings(me, patch) {
  const cur = getSettings(me);
  for (const [k, v] of Object.entries(patch && typeof patch === 'object' ? patch : {})) if (validSetting(k, v) && Object.keys(cur).length < 80) cur[k] = v;
  db.run('UPDATE users SET settings = ? WHERE id = ?', JSON.stringify(cur), me.id);
  return cur;
}
const FOREVER = 4102444800000;
function notifyList(me) {
  return Object.fromEntries(db.all('SELECT * FROM notify WHERE user_id = ?', me.id).map(r => [r.target, { level: r.level, muted_until: r.muted_until, push: !!r.push }]));
}
function setNotify(me, target, body = {}) {
  target = String(target || '');
  if (!db.get('SELECT 1 FROM channels WHERE cid = ?', target) && !db.get('SELECT 1 FROM communities WHERE sid = ?', target)) throw err('not_found', 404);
  const cur = { level: 'default', muted_until: null, push: true, ...(notifyList(me)[target] || {}) };
  if (['default', 'all', 'mentions', 'none'].includes(body.level)) cur.level = body.level;
  if (body.mute_minutes !== undefined) { const m = Number(body.mute_minutes); cur.muted_until = m === 0 ? null : m < 0 ? FOREVER : now() + Math.min(m, 60 * 24 * 365) * 60000; }
  if (typeof body.push === 'boolean') cur.push = body.push;
  db.run('INSERT OR REPLACE INTO notify (user_id, target, level, muted_until, push) VALUES (?, ?, ?, ?, ?)', me.id, target, cur.level, cur.muted_until, cur.push ? 1 : 0);
  return cur;
}

module.exports = {
  LIMITS, CHANNEL_TYPES, Snap, snapOf, snapById, findCommunity, memberCommunity, findChannel, userByPrincipalOrThrow, memberCount, categoriesOf, cfgOf,
  roleView, serverView, channelView, memberView, readState, mentionCounts, myServers, serverDetail,
  createCommunity, insertRole, insertChannel, updateServer, deleteCommunity, addMember, removeMember, memberChanged, leaveServer, memberList, moderateMember, banList, discover, discoveryCommunity, assertMayCreate, mirrorToConfig, syncFromConfig,
  findInvite, inviteInfo, listInvites, createInvite, deleteInvite, joinServer, listRequests, resolveRequest,
  channelName, createChannel, updateChannel, deleteChannel, setChannelPerms, setLayout, channelsChanged, onChannelsChanged, setCategories,
  createRole, updateRole, deleteRole, orderRoles, setMemberRole, setRoleIcon,
  listEmojis, allEmojis, createEmoji, renameEmoji, deleteEmoji, emojiView, emojiInfo, shopView, shopRole, welcomeMessage, cleanConfig, cleanTemplates: templateList,
  identities, getSettings, setSettings, SETTING_DEFAULTS, notifyList, setNotify, instanceOrigin,
};
