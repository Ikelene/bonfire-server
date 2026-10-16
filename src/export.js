'use strict';
// bonfire-export-v1 (PROTOCOL §9): export a community to a zip, import one back as a new community.
const fs = require('fs');
const path = require('path');
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const C = require('./communities');
const uploads = require('./uploads');
const { ALL_PERMS, CHANNEL_BITS } = require('./perms');
const { err, normalizeOrigin, randHex, sha256, now, clean } = require('./util');

const FORMAT = 'bonfire-export-v1';
const MAX_UNZIPPED = 2 * 1024 * 1024 * 1024;
const origin = () => normalizeOrigin(config.publicUrl());

// ---------------------------------------------------------------- export
function exportCommunity(sid, me) {
  const c = C.findCommunity(sid);
  const snap = C.snapOf(c);
  if (!snap.isOwner(me.id)) throw err('not_allowed', 403);
  const files = {};
  const fileRefs = new Map(); // upload path -> files/<path>
  // a locally hosted file becomes files/<path> inside the zip; anything else stays a URL
  const localFile = url => {
    if (typeof url !== 'string') return url ?? null;
    const prefix = origin() + '/uploads/';
    if (!url.startsWith(prefix)) return url;
    let rel; try { rel = decodeURIComponent(url.slice(prefix.length)); } catch { return url; }
    if (fileRefs.has(rel)) return fileRefs.get(rel);
    const abs = path.resolve(uploads.root(), rel);
    if (!abs.startsWith(path.resolve(uploads.root()) + path.sep)) return url;
    let data; try { data = fs.readFileSync(abs); } catch { return url; }
    const ref = 'files/' + rel;
    files[ref] = [data, { level: 0 }];
    fileRefs.set(rel, ref);
    return ref;
  };
  const roleByRid = id => snap.roles.find(r => r.id === id)?.rid;
  const emojis = db.all('SELECT * FROM emojis WHERE community_id = ? ORDER BY id', c.id).map(e => ({ eid: e.eid, name: e.name, animated: !!e.animated, file: localFile(`${origin()}/uploads/${e.file}`) }));
  const community = {
    name: c.name, description: c.description, icon: localFile(c.icon_url), banner: localFile(c.banner_url),
    settings: { join_policy: c.join_policy, allow_signing: !!c.allow_signing, require_signing: !!c.require_signing, allow_uploads: !!c.allow_uploads, upload_max_mb: c.upload_max_mb },
    categories: C.categoriesOf(c),
    channels: snap.channels.map(ch => ({
      cid: ch.cid, name: ch.name, topic: ch.topic, category: ch.category, position: ch.position, locked: !!ch.locked, type: ch.type, config: C.cfgOf(ch),
      perms: [...(snap.ow.get(ch.id) || new Map())].map(([rid, o]) => ({ role: roleByRid(rid), allow: o.allow, deny: o.deny })).filter(x => x.role),
    })),
    roles: snap.roles.map(r => ({ rid: r.rid, name: r.name, color: r.color || null, position: r.position, permissions: r.permissions, hoist: !!r.hoist, mentionable: !!r.mentionable, is_default: !!r.is_default })),
    emojis,
    invites: db.all('SELECT * FROM invites WHERE community_id = ?', c.id).map(i => ({ code: i.code, expires_at: i.expires_at ?? null, max_uses: i.max_uses ?? null })),
  };
  files['manifest.json'] = strToU8(JSON.stringify({ format: FORMAT, source: origin(), source_kind: 'instance', exported_at: now(), community: c.sid }));
  files['community.json'] = strToU8(JSON.stringify(community, null, 1));

  const members = db.all('SELECT u.*, m.joined_at FROM members m JOIN users u ON u.id = m.user_id WHERE m.community_id = ? ORDER BY m.joined_at, u.id', c.id);
  files['members.jsonl'] = strToU8(members.map(u => JSON.stringify({
    user: auth.userView(u), roles: [...snap.roleIds(u.id)].map(roleByRid).filter(Boolean), joined_at: u.joined_at, ...(snap.isOwner(u.id) ? { owner: true } : {}),
  })).join('\n') + (members.length ? '\n' : ''));

  for (const ch of snap.channels) {
    const lines = [];
    let last = 0;
    for (;;) {
      const rows = db.all(`SELECT m.*, u.principal AS u_principal, u.kind AS u_kind, u.username AS u_username, u.display_name AS u_dn, u.pfp AS u_pfp, u.velora_id AS u_vid
        FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.channel_id = ? AND m.id > ? ORDER BY m.id LIMIT 1000`, ch.id, last);
      if (!rows.length) break;
      last = rows[rows.length - 1].id;
      const rx = new Map();
      for (const r of db.raw().prepare(`SELECT r.message_id, r.emoji, u.principal FROM reactions r JOIN users u ON u.id = r.user_id WHERE r.message_id IN (${db.inList(rows)}) ORDER BY r.created_at, r.rowid`).all(...rows.map(x => x.id))) {
        if (!rx.has(r.message_id)) rx.set(r.message_id, []);
        const list = rx.get(r.message_id);
        let e = list.find(x => x.emoji === r.emoji);
        if (!e) { e = { emoji: r.emoji, users: [] }; list.push(e); }
        e.users.push(r.principal);
      }
      for (const r of rows) {
        let atts = []; try { atts = r.attachments ? JSON.parse(r.attachments) : []; } catch { atts = []; }
        const o = {
          id: String(r.id),
          author: r.u_principal ? { id: r.u_principal, kind: r.u_kind, username: r.u_username, display_name: r.u_dn, pfp: r.u_pfp || null, velora_id: r.u_vid || null } : null,
          ...(!r.u_principal && r.author_name ? { author_name: r.author_name, author_avatar: r.author_avatar || null } : {}),
          body: r.body, attachments: atts.map(a => ({ ...a, url: localFile(a.url) })),
          ...(r.embeds ? { embeds: JSON.parse(r.embeds) } : {}),
          reply_to: r.reply_to ? String(r.reply_to) : null, created_at: r.created_at, edited_at: r.edited_at || null, system: !!r.system,
          ...(r.sys_kind ? { sys_kind: r.sys_kind } : {}), pinned: !!r.pinned_at, reactions: rx.get(r.id) || [],
          ...(r.sig_kid ? { signature: { kid: r.sig_kid, sig: r.sig_sig, ts: r.sig_ts, nonce: r.sig_nonce } } : {}),
          ...(r.bridge ? { bridge: r.bridge } : {}),
        };
        lines.push(JSON.stringify(o));
      }
    }
    files[`messages/${ch.cid}.jsonl`] = strToU8(lines.join('\n') + (lines.length ? '\n' : ''));
  }
  return Buffer.from(zipSync(files, { level: 6 }));
}

// ---------------------------------------------------------------- import
const jsonl = u8 => strFromU8(u8).split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

function importCommunity(me, buffer) {
  C.assertMayCreate(me);
  let total = 0, entries;
  try { entries = unzipSync(new Uint8Array(buffer), { filter: f => { total += f.originalSize; if (total > MAX_UNZIPPED) throw new Error('too big'); return true; } }); } catch { throw err('invalid_export', 400); }
  let manifest, cj;
  try { manifest = JSON.parse(strFromU8(entries['manifest.json'])); cj = JSON.parse(strFromU8(entries['community.json'])); } catch { throw err('invalid_export', 400); }
  if (manifest?.format !== FORMAT || !cj || typeof cj !== 'object' || !Array.isArray(cj.channels) || !Array.isArray(cj.roles)) throw err('invalid_export', 400);
  const sameInstance = normalizeOrigin(manifest.source) === origin();
  const velora = config.mode() === 'velora';
  const sidTag = randHex(4);
  const storeFile = (ref, kind) => { // files/<path> inside the zip -> a file under uploads/, returning its URL
    const data = typeof ref === 'string' && ref.startsWith('files/') ? entries[ref] : null;
    if (!data || ref.includes('..')) return null;
    const rel = `imported/${sidTag}/${kind}/${path.basename(ref)}`;
    uploads.writeStored(rel, Buffer.from(data));
    return `${origin()}/uploads/${rel}`;
  };
  const mapUrl = (v, kind) => (typeof v === 'string' && v.startsWith('files/') ? storeFile(v, kind) : (/^https?:\/\//.test(v || '') ? v : null));

  // who is who: v: principals keep identity; l: principals only if they're this instance's own accounts
  const resolve = u => {
    const principal = typeof u === 'string' ? u : u?.id;
    if (typeof principal !== 'string') return null;
    if (principal.startsWith('v:') && /^v:[1-9]\d{0,19}$/.test(principal)) return auth.ensureVeloraPlaceholder(principal.slice(2), u?.username, u?.pfp);
    if (principal.startsWith('l:') && sameInstance) return auth.userByPrincipal(principal) || null;
    return null;
  };

  const result = db.tx(() => {
    const st = cj.settings || {};
    const c = C.createCommunity(me, { name: cj.name, description: cj.description, join_policy: ['open', 'request'].includes(st.join_policy) ? st.join_policy : 'request' }, { empty: true });
    const set = { allow_uploads: st.allow_uploads === false ? 0 : 1, upload_max_mb: Number.isInteger(st.upload_max_mb) && st.upload_max_mb >= 1 && st.upload_max_mb <= 500 ? st.upload_max_mb : 25 };
    if (velora) { set.allow_signing = st.allow_signing ? 1 : 0; set.require_signing = st.allow_signing && st.require_signing ? 1 : 0; }
    set.icon_url = mapUrl(cj.icon, 'chat'); set.banner_url = mapUrl(cj.banner, 'chat');
    db.run(`UPDATE communities SET ${Object.keys(set).map(k => k + ' = ?').join(', ')} WHERE id = ?`, ...Object.values(set), c.id);

    // roles (old rid -> new row)
    const roleMap = new Map();
    const everyoneNew = db.get('SELECT * FROM roles WHERE community_id = ? AND is_default = 1', c.id);
    const roleList = cj.roles.filter(r => r && typeof r.rid === 'string').slice(0, C.LIMITS.roles);
    for (const r of roleList.filter(x => x.is_default)) { db.run('UPDATE roles SET permissions = ? WHERE id = ?', (Number(r.permissions) || 0) & ALL_PERMS & ~0, everyoneNew.id); roleMap.set(r.rid, everyoneNew); }
    let pos = 1;
    for (const r of roleList.filter(x => !x.is_default).sort((a, b) => (a.position || 0) - (b.position || 0))) {
      roleMap.set(r.rid, C.insertRole(c.id, { name: clean(r.name, 40) || 'role', color: /^#[0-9a-f]{6}$/i.test(r.color || '') ? r.color : null, position: pos++, permissions: (Number(r.permissions) || 0) & ALL_PERMS, hoist: r.hoist, mentionable: r.mentionable }));
    }
    // channels + overwrites
    const chMap = new Map();
    const cats = [...new Set([...(Array.isArray(cj.categories) ? cj.categories : []), ...cj.channels.map(x => x?.category)].map(x => clean(x, 40)).filter(Boolean))].slice(0, 30);
    if (!cats.length) cats.push('Text channels');
    C.setCategories(c, cats);
    let i = 0;
    for (const x of cj.channels.slice(0, C.LIMITS.channels)) {
      if (!x || typeof x.cid !== 'string') continue;
      const type = C.CHANNEL_TYPES.includes(x.type) ? x.type : 'text';
      const row = C.insertChannel(c.id, { name: C.channelName(x.name) || 'channel', topic: x.topic, category: clean(x.category, 40) || cats[0], locked: !!x.locked, type, config: type === 'voice' ? { allow_call_in: !!x.config?.allow_call_in, user_limit: Math.min(Math.max(Math.trunc(Number(x.config?.user_limit) || 0), 0), 99) } : {} }, Number.isFinite(x.position) ? x.position : i);
      i++;
      chMap.set(x.cid, row);
      for (const o of Array.isArray(x.perms) ? x.perms : []) {
        const role = roleMap.get(o?.role);
        const allow = (Number(o?.allow) || 0) & CHANNEL_BITS, deny = (Number(o?.deny) || 0) & CHANNEL_BITS;
        if (role && (allow || deny)) db.run('INSERT OR REPLACE INTO channel_perms (channel_id, role_id, allow, deny) VALUES (?, ?, ?, ?)', row.id, role.id, allow & ~deny, deny);
      }
    }
    if (!chMap.size) { const row = C.insertChannel(c.id, { name: 'general', category: cats[0], type: 'text' }, 0); chMap.set('_', row); }
    // emojis
    for (const e of (Array.isArray(cj.emojis) ? cj.emojis : []).slice(0, C.LIMITS.emojis)) {
      const data = e && typeof e.file === 'string' ? entries[e.file] : null;
      if (!data) continue;
      try {
        const eid = 'e' + randHex(5);
        const { file, animated } = uploads.saveEmoji(Buffer.from(data), eid);
        db.run('INSERT INTO emojis (eid, community_id, name, animated, file, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', eid, c.id, clean(e.name, 32).replace(/[^A-Za-z0-9_]/g, '_') || 'emoji', animated ? 1 : 0, file, me.id, now());
      } catch { /* skip an unusable emoji */ }
    }
    // invites: same limits, fresh codes
    for (const inv of (Array.isArray(cj.invites) ? cj.invites : []).slice(0, 50)) {
      if (inv?.expires_at && inv.expires_at <= now()) continue;
      db.run('INSERT INTO invites (code, community_id, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?)', randHex(4), c.id, me.id, now(), inv?.expires_at || null, Number.isInteger(inv?.max_uses) ? inv.max_uses : null);
    }

    // messages, oldest first per channel
    const idMap = new Map(); // old message id -> new id
    const replies = [];
    for (const [oldCid, ch] of chMap) {
      const file = entries[`messages/${oldCid}.jsonl`];
      if (!file) continue;
      for (const m of jsonl(file)) {
        const u = m.author ? resolve(m.author) : null;
        const nameOnly = !u && !m.system ? (m.author_name || m.author?.display_name || m.author?.username || null) : null;
        const atts = (Array.isArray(m.attachments) ? m.attachments : []).slice(0, 10).map(a => {
          if (typeof a?.url !== 'string') return null;
          if (!a.url.startsWith('files/')) return /^https?:\/\//.test(a.url) ? a : null;
          const data = entries[a.url];
          if (!data) return null;
          const rel = `imported/${sidTag}/a/${randHex(6)}-${path.basename(a.url)}`;
          const buf = Buffer.from(data);
          uploads.writeStored(rel, buf);
          const sn = uploads.sniff(buf);
          const rec = { name: clean(a.name, 120) || path.basename(a.url), size: buf.length, mime: a.mime || 'application/octet-stream', type: ['image', 'gif', 'video', 'audio', 'file'].includes(a.type) ? a.type : (sn?.type || 'file') };
          const hash = sha256(buf);
          db.run('INSERT OR IGNORE INTO uploads (path, sha256, name, size, mime, type, width, height, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', rel, hash, rec.name, rec.size, rec.mime, rec.type, a.width || null, a.height || null, me.id, now());
          return { url: `${origin()}/uploads/${rel}`, type: rec.type, name: rec.name, size: rec.size, width: a.width || undefined, height: a.height || undefined, sha256: hash };
        }).filter(Boolean);
        const sig = m.signature && typeof m.signature.kid === 'string' && typeof m.signature.sig === 'string' ? m.signature : null;
        const created = Number(m.created_at) || now();
        const res = db.run(
          `INSERT INTO messages (channel_id, user_id, body, attachments, system, sys_kind, author_name, author_avatar, embeds, bridge, pinned_at, created_at, edited_at, sig_kid, sig_sig, sig_ts, sig_nonce, verified)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ch.id, u?.id ?? null, String(m.body ?? '').slice(0, 4000), atts.length ? JSON.stringify(atts) : null, m.system ? 1 : 0, m.sys_kind ? String(m.sys_kind).slice(0, 12) : null,
          nameOnly ? clean(nameOnly, 80) : null, nameOnly ? (m.author_avatar || m.author?.pfp || null) : null, Array.isArray(m.embeds) ? JSON.stringify(m.embeds) : null, m.bridge ? String(m.bridge).slice(0, 10) : null,
          m.pinned ? created : null, created, Number(m.edited_at) || null, sig?.kid ?? null, sig?.sig ?? null, sig ? Number(sig.ts) || 0 : null, sig ? String(sig.nonce ?? '') : null, sig ? 0 : null);
        const nid = Number(res.lastInsertRowid);
        idMap.set(String(m.id), nid);
        if (m.reply_to) replies.push([nid, String(m.reply_to)]);
        for (const rx of Array.isArray(m.reactions) ? m.reactions : []) {
          if (typeof rx?.emoji !== 'string') continue;
          for (const uid of (rx.users || []).slice(0, 5000)) { const ru = resolve(uid); if (ru) db.run('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)', nid, ru.id, rx.emoji.slice(0, 64), created); }
        }
        db.run('UPDATE channels SET last_message_id = ? WHERE id = ?', nid, ch.id);
      }
    }
    for (const [nid, old] of replies) { const target = idMap.get(old); if (target) db.run('UPDATE messages SET reply_to = ? WHERE id = ?', target, nid); }
    // the importer reads everything they just imported
    for (const uid of new Set([me.id, c.owner_id])) for (const ch of chMap.values()) db.run('INSERT OR REPLACE INTO read_state (user_id, channel_id, last_read_id) SELECT ?, id, last_message_id FROM channels WHERE id = ?', uid, ch.id);

    // members: accounts of this instance's kind come back with their roles (the owner and the importer are already members)
    const toAnnounce = [];
    for (const m of entries['members.jsonl'] ? jsonl(entries['members.jsonl']) : []) {
      const u = resolve(m.user);
      if (!u || u.id === me.id || u.kind !== (velora ? 'velora' : 'local') || (!velora && !sameInstance)) continue;
      if (db.get('SELECT 1 FROM members WHERE community_id = ? AND user_id = ?', c.id, u.id)) continue;
      if (C.memberCount(c.id) >= C.LIMITS.members) break;
      C.addMember(c, u.id, { quiet: true, announce: false });
      db.run('UPDATE members SET joined_at = ? WHERE community_id = ? AND user_id = ?', Number(m.joined_at) || now(), c.id, u.id);
      for (const rid of Array.isArray(m.roles) ? m.roles : []) { const r = roleMap.get(rid); if (r && !r.is_default) db.run('INSERT OR IGNORE INTO member_roles (community_id, user_id, role_id) VALUES (?, ?, ?)', c.id, u.id, r.id); }
      toAnnounce.push(u.id);
    }
    setImmediate(() => { const fresh = db.get('SELECT * FROM communities WHERE id = ?', c.id); if (!fresh) return; const snap = C.snapOf(fresh); for (const uid of toAnnounce) require('./gateway').pushToUser(uid, { type: 'chat_server_added', server: C.serverView(fresh, snap, auth.userById(uid)) }); });
    return db.get('SELECT * FROM communities WHERE id = ?', c.id);
  });
  C.mirrorToConfig(result);
  return result;
}

module.exports = { exportCommunity, importCommunity, FORMAT };
