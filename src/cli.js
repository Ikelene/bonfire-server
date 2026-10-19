#!/usr/bin/env node
'use strict';
// Maintenance commands, run inside the container by bonfire-hostd (`docker exec`):
//   node src/cli.js export <out.zip>    write the community as a bonfire-export-v1 zip (PROTOCOL §9); exit 3 when the instance has none
const fs = require('fs');
const config = require('./config');
const db = require('./db');

function main(argv) {
  const [cmd, out] = argv;
  if (cmd !== 'export' || !out) { console.error('usage: node src/cli.js export <out.zip>'); return 2; }
  config.init({});
  db.open();
  try {
    const zip = require('./export').exportForBackup();
    if (!zip) { console.error('nothing to export: no community yet'); return 3; }
    fs.writeFileSync(out, zip, { mode: 0o600 });
    console.log(JSON.stringify({ ok: true, size: zip.length }));
    return 0;
  } finally { db.close(); }
}
if (require.main === module) { try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('export failed:', e.message); process.exitCode = 1; } }
module.exports = { main };
