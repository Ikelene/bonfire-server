'use strict';
// Permission bits + the permission algorithm (ported from Velora chat.js permsOf / channelPermsOf / canView / canPost / topPosition).
// Everything here is a pure function of plain data, so it can be unit-tested without a database.
//
//   roles       [{ id, permissions, is_default, position }]
//   roleIds     Set of role ids the member holds (@everyone is implicit)
//   overwrites  Map(roleId -> { allow, deny }) for one channel
const P = {
  SEND: 1, MANAGE_CHANNELS: 2, MANAGE_SERVER: 4, MANAGE_ROLES: 8, KICK: 16, BAN: 32,
  MANAGE_MESSAGES: 64, MENTION_EVERYONE: 128, ATTACH: 256, ADMIN: 512,
  VIEW: 1024, // channel-level only
};
const CHANNEL_BITS = P.VIEW | P.SEND | P.ATTACH; // what a channel's per-role settings can allow / deny
const ALL_PERMS = 1023;
const EVERYONE_DEFAULT = P.SEND | P.ATTACH;

// community-wide permissions: owner = all, Administrator = all, otherwise OR of @everyone + held roles
function basePerms({ isMember = true, isOwner = false, roles = [], roleIds = new Set() }) {
  if (!isMember) return 0;
  if (isOwner) return ALL_PERMS;
  let p = 0;
  for (const r of roles) if (r.is_default || roleIds.has(r.id)) p |= Number(r.permissions);
  return (p & P.ADMIN) ? ALL_PERMS : p;
}

// one channel: community perms, then the channel's @everyone setting, then the member's roles' settings (deny first, then allow)
function channelPerms(base, { overwrites = null, everyoneId = null, roleIds = new Set() } = {}) {
  if (base === ALL_PERMS) return ALL_PERMS | P.VIEW;
  let p = base | P.VIEW;
  if (!overwrites || !overwrites.size) return p;
  const e = everyoneId != null ? overwrites.get(everyoneId) : null;
  if (e) p = (p & ~e.deny) | e.allow;
  let allow = 0, deny = 0;
  for (const rid of roleIds) { const o = overwrites.get(rid); if (o) { allow |= o.allow; deny |= o.deny; } }
  return (p & ~deny) | allow;
}

// people who manage channels (or administrate) always see every channel so they can fix it
function canView(base, chPerms, isMember = true) {
  return !!isMember && (base === ALL_PERMS || (base & (P.ADMIN | P.MANAGE_CHANNELS)) !== 0 || (chPerms & P.VIEW) !== 0);
}

// Bonfire Link game channels override visibility: console = Manage server only (even over Manage channels), not set up yet =
// managers only. -> true (visible), false (hidden) or null (the normal rules)
function gameView(channel, base) {
  if ((channel.type || 'text') !== 'game') return null;
  const cfg = cfgOf(channel);
  if (cfg.purpose === 'console') return (base & P.MANAGE_SERVER) !== 0;
  if (!cfg.instance || !cfg.purpose) return (base & (P.ADMIN | P.MANAGE_SERVER | P.MANAGE_CHANNELS)) !== 0;
  return null;
}

// which channel types have no chat at all / only managers (or webhooks) post / take messages only when `allow_chat` is on
const NO_CHAT = new Set(['voice', 'roles', 'link', 'starboard']);
const cfgOf = ch => { const c = ch.config; if (c && typeof c === 'object') return c; try { return JSON.parse(c || '{}') || {}; } catch { return {}; } };
// no-chat types (voice, roles shop, link, starboard) never take messages; logs, welcome (unless allow_chat) and locked channels
// need MANAGE_MESSAGES; otherwise SEND in the channel
function canPost(channel, base, chPerms, isMember = true) {
  if (!isMember) return false;
  const type = channel.type || 'text';
  if (NO_CHAT.has(type)) return false;
  if (type === 'game' && cfgOf(channel).purpose !== 'chat') return false; // Bonfire Link: only synced-chat game channels take messages
  if (type === 'logs' && cfgOf(channel).mode === 'cloudlink' && !channel.locked) return canView(base, chPerms, isMember) && (chPerms & P.SEND) !== 0; // CloudLink bridge: chat both ways
  if (type === 'logs' || (type === 'welcome' && !cfgOf(channel).allow_chat) || channel.locked) return (base & P.MANAGE_MESSAGES) !== 0;
  return canView(base, chPerms, isMember) && (chPerms & P.SEND) !== 0;
}

// how high someone sits (their highest role); you can only manage people and roles below you
function topPosition(roles, roleIds, isOwner) {
  if (isOwner) return Infinity;
  let top = 0;
  for (const r of roles) if (!r.is_default && roleIds.has(r.id)) top = Math.max(top, r.position);
  return top;
}

// you can't hand out permissions you don't have yourself, and can't strip ones you lack
const grantable = (requested, actorPerms, existing = 0) => (((Number(requested) || 0) & ALL_PERMS & actorPerms) | (Number(existing) & ~actorPerms)) & ALL_PERMS;

// may `actor` edit this role? (needs MANAGE_ROLES and the role must sit below the actor; @everyone is always editable)
const canManageRole = (actorPerms, actorTop, role) => (actorPerms & P.MANAGE_ROLES) !== 0 && (!role || !!role.is_default || role.position < actorTop);

// 'owner' / 'admin' (has Administrator) / 'member' - the little chip on profiles
const roleLabel = (isOwner, base) => (isOwner ? 'owner' : base === ALL_PERMS ? 'admin' : 'member');

module.exports = { NO_CHAT, gameView, P, CHANNEL_BITS, ALL_PERMS, EVERYONE_DEFAULT, basePerms, channelPerms, canView, canPost, topPosition, grantable, canManageRole, roleLabel };
