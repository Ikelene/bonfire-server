'use strict';
// Velora relays, instance side (PROTOCOL §12, "Instance behaviour"): started by index.js once the HTTP server listens.
const client = require('./client');
const parts = () => [require('./push'), require('./daily'), require('./shop'), require('./broker'), require('./directory'), require('./gallery'), require('./identity')];

function start() {
  client.loadKey();
  for (const p of parts()) p.start();
  client.start(); // registration last: its 'registered' event reaches every part
}
function stop() {
  for (const p of parts()) { try { p.stop(); } catch { /* best effort */ } }
  client.stop();
}
const status = () => ({ ...client.status(), voice_backend: require('../voice').backendName(), directory: require('./directory').status() });
module.exports = { start, stop, status, client };
