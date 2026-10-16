'use strict';
// Import a Discord / Fluxer server prepared on Velora (PROTOCOL §12.6): the person hands the instance a one-time ticket,
// the instance downloads the bonfire-export-v1 bundle with a signed request and feeds it to the normal zip importer.
const C = require('../communities');
const exp = require('../export');
const client = require('./client');
const { err } = require('../util');

const MAX_BUNDLE = 256 * 1024 * 1024;
const MAP = { // Velora's answer -> what the client is told
  ticket_invalid: [404, 'The import ticket is not valid.'],
  ticket_wrong_instance: [403, 'This ticket was made for a different instance url.'],
  not_ready: [409, 'Velora is still building the import. Try again in a moment.'],
  ticket_expired: [410, 'The ticket was already used or has expired. Run the import on Velora again.'],
  import_failed: [410, 'The import failed on Velora. Run it again.'],
  bundle_missing: [410, 'The import file is gone. Run the import on Velora again.'],
};

async function importFromVelora(me, ticket) {
  C.assertMayCreate(me); // 403 forbidden / 409 community_exists before contacting Velora
  if (typeof ticket !== 'string' || !/^bit_[A-Za-z0-9_-]{43}$/.test(ticket)) throw err('ticket_invalid', 400);
  if (!client.enabled()) throw err('velora_off', 503, { message: 'Velora relays are switched off on this instance (velora_registration: "off").' });
  if (!client.registered()) throw err('velora_not_registered', 503, { message: 'This instance is not registered with Velora yet.', retry: true });
  let buf;
  try { buf = await client.call('GET', `/bonfire/relay/import/bundle?ticket=${ticket}`, undefined, { binary: true, timeout: 10 * 60 * 1000, maxBytes: MAX_BUNDLE }); } catch (e) {
    const m = MAP[e.code];
    if (m) throw err(e.code, m[0], { message: m[1], ...(e.code === 'not_ready' ? { retry: true } : {}) });
    if (e.status === 429) throw err('rate_limited', 429, { retry: true, retry_after: e.extra?.retry_after });
    throw err('velora_download_failed', 502, { message: 'Could not download the import from Velora.', detail: e.code || null });
  }
  C.assertMayCreate(me); // someone may have set the community up meanwhile
  const c = exp.importCommunity(me, buf);
  return { sid: c.sid };
}
module.exports = { importFromVelora };
