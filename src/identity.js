'use strict';
// Join / leave notice templates ({user}, {server}, {count}) -> parts; null = "the account goes here" (ported from Velora's chat-identity.js)
const DEFAULT_JOIN = ['{user} just showed up!', 'Welcome, {user}. Make yourself at home.', '{user} joined the party.', 'Everyone say hi to {user}!', '{user} hopped into the server.', 'A wild {user} appeared.'];
const DEFAULT_LEAVE = ['{user} left the server.', '{user} headed out.', 'See you around, {user}.'];
const partsFor = (template, { server = '', count = 0 } = {}) => String(template).split(/(\{user\})/g)
  .map(part => (part === '{user}' ? null : part.replace(/\{server\}/g, () => String(server)).replace(/\{count\}/g, () => String(count))));
const renderParts = (parts, username) => parts.map(p => (p === null ? (username ? '@' + username : 'Deleted account') : p)).join('');
module.exports = { DEFAULT_JOIN, DEFAULT_LEAVE, partsFor, renderParts };
