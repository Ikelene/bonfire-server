'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { P, ALL_PERMS, basePerms, channelPerms, canView, canPost, topPosition, grantable, canManageRole, EVERYONE_DEFAULT } = require('../src/perms');

const everyone = { id: 1, permissions: EVERYONE_DEFAULT, is_default: 1, position: 0 };
const mod = { id: 2, permissions: P.KICK | P.MANAGE_MESSAGES, is_default: 0, position: 2 };
const speaker = { id: 3, permissions: P.MENTION_EVERYONE, is_default: 0, position: 1 };
const admin = { id: 4, permissions: P.ADMIN, is_default: 0, position: 5 };
const roles = [everyone, speaker, mod, admin];
const base = (ids = [], extra = {}) => basePerms({ roles, roleIds: new Set(ids), ...extra });

test('owner has every permission', () => assert.equal(base([], { isOwner: true }), ALL_PERMS));
test('non-members have nothing', () => assert.equal(base([], { isMember: false }), 0));
test('@everyone applies to everybody', () => assert.equal(base([]), P.SEND | P.ATTACH));
test('roles are OR-ed with @everyone', () => assert.equal(base([2, 3]), P.SEND | P.ATTACH | P.KICK | P.MANAGE_MESSAGES | P.MENTION_EVERYONE));
test('ADMIN grants everything', () => { assert.equal(base([4]), ALL_PERMS); assert.equal(channelPerms(base([4]), {}) & P.VIEW, P.VIEW); });

const ow = entries => new Map(entries);
test('channel: everyone can view by default (VIEW is implicit)', () => {
  const b = base([]);
  const cp = channelPerms(b, { everyoneId: 1, roleIds: new Set(), overwrites: null });
  assert.ok(canView(b, cp));
  assert.ok(cp & P.SEND);
});
test('channel overwrite on @everyone denies VIEW; a role allow brings it back', () => {
  const o = ow([[1, { allow: 0, deny: P.VIEW }], [3, { allow: P.VIEW, deny: 0 }]]);
  const plain = channelPerms(base([]), { overwrites: o, everyoneId: 1, roleIds: new Set() });
  assert.equal(canView(base([]), plain), false);
  const withRole = channelPerms(base([3]), { overwrites: o, everyoneId: 1, roleIds: new Set([3]) });
  assert.equal(canView(base([3]), withRole), true);
});
test('role overwrites: @everyone applied first, then the OR of role denies, then the OR of role allows (allow wins)', () => {
  const o = ow([[1, { allow: 0, deny: P.SEND }], [2, { allow: P.SEND, deny: 0 }], [3, { allow: 0, deny: P.SEND }]]);
  const cp = channelPerms(base([2, 3]), { overwrites: o, everyoneId: 1, roleIds: new Set([2, 3]) });
  assert.equal(cp & P.SEND, P.SEND); // a role allow re-grants what @everyone / another role denied, exactly like Velora
  const denyOnly = channelPerms(base([3]), { overwrites: o, everyoneId: 1, roleIds: new Set([3]) });
  assert.equal(denyOnly & P.SEND, 0);
  const onlyAllow = channelPerms(base([2]), { overwrites: o, everyoneId: 1, roleIds: new Set([2]) });
  assert.equal(onlyAllow & P.SEND, P.SEND);
});
test('people with MANAGE_CHANNELS / ADMIN always see every channel', () => {
  const o = ow([[1, { allow: 0, deny: P.VIEW }]]);
  const manage = { id: 9, permissions: P.MANAGE_CHANNELS, is_default: 0, position: 1 };
  const rs = [everyone, manage];
  const b = basePerms({ roles: rs, roleIds: new Set([9]) });
  const cp = channelPerms(b, { overwrites: o, everyoneId: 1, roleIds: new Set([9]) });
  assert.equal(cp & P.VIEW, 0);
  assert.equal(canView(b, cp), true);
  const owner = basePerms({ roles: rs, roleIds: new Set(), isOwner: true });
  assert.equal(canView(owner, channelPerms(owner, { overwrites: o, everyoneId: 1 })), true);
});
test('canPost: SEND needed, VIEW gate, locked channels, voice', () => {
  const text = { type: 'text', locked: 0 };
  const b = base([]);
  assert.equal(canPost(text, b, channelPerms(b, { everyoneId: 1 })), true);
  const noSend = ow([[1, { allow: 0, deny: P.SEND }]]);
  assert.equal(canPost(text, b, channelPerms(b, { overwrites: noSend, everyoneId: 1 })), false);
  const hidden = ow([[1, { allow: 0, deny: P.VIEW }]]);
  assert.equal(canPost(text, b, channelPerms(b, { overwrites: hidden, everyoneId: 1 })), false);
  const locked = { type: 'text', locked: 1 };
  assert.equal(canPost(locked, b, channelPerms(b, { everyoneId: 1 })), false);
  const bm = base([2]);
  assert.equal(canPost(locked, bm, channelPerms(bm, { everyoneId: 1, roleIds: new Set([2]) })), true);
  assert.equal(canPost({ type: 'voice', locked: 0 }, b, channelPerms(b, { everyoneId: 1 })), false);
  assert.equal(canPost(text, 0, 0, false), false);
});
test('hierarchy: topPosition, role management, grantable clamps', () => {
  assert.equal(topPosition(roles, new Set(), false), 0);
  assert.equal(topPosition(roles, new Set([2, 3]), false), 2);
  assert.equal(topPosition(roles, new Set(), true), Infinity);
  const manager = { id: 7, permissions: P.MANAGE_ROLES | P.KICK, is_default: 0, position: 3 };
  const rs = [everyone, mod, manager];
  const mine = basePerms({ roles: rs, roleIds: new Set([7]) });
  const top = topPosition(rs, new Set([7]), false);
  assert.equal(canManageRole(mine, top, mod), true);       // position 2 < 3
  assert.equal(canManageRole(mine, top, manager), false);  // not below yourself
  assert.equal(canManageRole(mine, top, everyone), true);
  assert.equal(canManageRole(P.SEND, top, mod), false);    // needs MANAGE_ROLES
  // can't give out what you don't have, can't strip what you can't touch
  assert.equal(grantable(P.KICK | P.BAN | P.ADMIN, mine), P.KICK);
  assert.equal(grantable(0, mine, P.BAN | P.KICK), P.BAN);
});

test('canPost by channel type: roles / link / voice / starboard never; logs, welcome and locked need Manage messages', () => {
  const b = base([]), bm = base([2]), ch = (b, ids = []) => channelPerms(b, { everyoneId: 1, roleIds: new Set(ids) });
  for (const type of ['roles', 'link', 'voice', 'starboard']) {
    assert.equal(canPost({ type, locked: 0 }, b, ch(b)), false, type);
    assert.equal(canPost({ type, locked: 0 }, ALL_PERMS, ch(ALL_PERMS)), false, type + ' (owner)');
  }
  assert.equal(canPost({ type: 'logs', locked: 0 }, b, ch(b)), false);
  assert.equal(canPost({ type: 'logs', locked: 0 }, bm, ch(bm, [2])), true);
  assert.equal(canPost({ type: 'welcome', locked: 0, config: '{}' }, b, ch(b)), false);
  assert.equal(canPost({ type: 'welcome', locked: 0, config: '{}' }, bm, ch(bm, [2])), true);
  assert.equal(canPost({ type: 'welcome', locked: 0, config: '{"allow_chat":true}' }, b, ch(b)), true);
  assert.equal(canPost({ type: 'welcome', locked: 0, config: { allow_chat: true } }, b, ch(b)), true);
  assert.equal(canPost({ type: 'welcome', locked: 1, config: '{"allow_chat":true}' }, b, ch(b)), false);
  assert.equal(canPost({ type: 'welcome', config: 'not json' }, b, ch(b)), false);
  assert.equal(canPost({ type: 'text', locked: 0 }, b, ch(b)), true);
});
