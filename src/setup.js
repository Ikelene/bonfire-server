'use strict';
// First-boot claiming: setup code (Crockford base32 XXXX-XXXX) printed to stdout and DATA_DIR/setup-code.txt.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const { setupCode, normCode, safeEqual, log } = require('./util');

const file = () => path.join(config.dir(), 'setup-code.txt');
let code = null;

function boot() {
  code = null;
  if (auth.claimed()) { try { fs.unlinkSync(file()); } catch { /* none */ } return; }
  const pre = process.env.BONFIRE_OWNER;
  if (pre) {
    const m = /^v:([1-9]\d{0,19})$/.exec(pre.trim());
    if (m) {
      const u = auth.ensureVeloraPlaceholder(m[1]);
      auth.setOwner(u.id);
      log(`[setup] instance claimed by ${pre} (BONFIRE_OWNER)`);
      try { fs.unlinkSync(file()); } catch { /* none */ }
      return;
    }
    console.error(`[setup] ignoring BONFIRE_OWNER="${pre}" (expected v:<velora user id>)`);
  }
  try { code = fs.readFileSync(file(), 'utf8').trim(); } catch { /* none yet */ }
  if (!/^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(code || '')) {
    code = setupCode();
    fs.writeFileSync(file(), code + '\n', { mode: 0o600 });
  }
  log('');
  log('  This instance is not claimed yet. Log in, then claim it with the setup code:');
  log(`      ${code}`);
  log(`  (also in ${file()})`);
  log('');
}
const current = () => code;
const check = given => !!code && safeEqual(normCode(given), normCode(code));
function claim(user) {
  auth.setOwner(user.id);
  code = null;
  try { fs.unlinkSync(file()); } catch { /* gone */ }
  log(`[setup] instance claimed by ${user.principal} (${user.username})`);
}
module.exports = { boot, current, check, claim };
