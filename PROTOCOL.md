# Bonfire Instance Protocol — v1

This is the contract between three parties:

- **Velora** (`VELORA` = Velora base URL, e.g. `https://velora.ikelene.net`, dev `http://localhost:3000`) — identity provider, the account signing key, DMs.
- **Instance** (`INSTANCE` = origin of a bonfire-server, e.g. `https://chat.ikelene.net`, dev `http://localhost:4100`) — hosts exactly **one community** (what the UI calls a "server"). Adding an instance's URL in Bonfire *is* joining that server.
- **Client** — Bonfire (web `/chat`, desktop, android).

Terminology in code and docs: **instance** (the running server process at a URL) and **community** (its one Discord-like server). One instance = one community (§5a). On the wire, paths keep the old `servers` / `sid` naming so the existing client and response shapes carry over (see §6).

All JSON. All errors are `{ "error": "<snake_code>", ...extra }` with a fitting HTTP status. All instance HTTP routes send `Access-Control-Allow-Origin: *` and allow the `Authorization, Content-Type, X-Device-Fingerprint` headers. No cookies anywhere. The client is always served from Velora, so every instance call is cross-origin. Bonfire works **without a Velora sign-in** (local-account instances); a Velora sign-in is only needed for DMs, group chats and Velora-login instances.

---

## 1. Origins and normalization

`normalizeOrigin(url)` means: parse it, lowercase the scheme and host, drop the default port (80 for http, 443 for https), drop the path, query and trailing slash. The result is `scheme://host[:port]`. Velora puts the instance origin in a token's `aud`, and instances compare `aud` with their own `public_url` (config), normalized the same way.

Production requires `https`. `http` audiences are accepted only when Velora runs with `BONFIRE_DEV=1`.

---

## 2. Velora identity API

### 2.1 JWKS
`GET VELORA/.well-known/bonfire/jwks.json` returns:
```json
{ "keys": [ { "kty": "OKP", "crv": "Ed25519", "x": "<b64url raw 32B>", "kid": "<kid>", "alg": "EdDSA", "use": "sig" } ] }
```
The signing key is stored at `BONFIRE_IDP_KEY` (default `/opt/secrets/bonfire-idp.key`, PKCS8 PEM), and Velora generates it on first use if it's missing. `kid` is the first 16 hex characters of `sha256(raw public key)`. Instances cache JWKS for 10 minutes, and refetch it once when they see an unknown `kid`.

### 2.2 Instance token
`POST VELORA/bonfire/instance-token` takes a Velora bearer token and needs scope `CHAT` (2048).
Request `{ "instance": "<any url>" }` returns `{ "token": "<jwt>", "expires_at": <ms>, "aud": "<normalized origin>" }`.

The JWT is compact and signed with EdDSA (Ed25519).
- Header: `{ "alg": "EdDSA", "typ": "JWT", "kid": "<kid>" }`
- Claims:

| claim | value |
|---|---|
| `iss` | Velora `BASE_URL`, normalized |
| `sub` | Velora `users.id` as a **string** |
| `aud` | normalized instance origin |
| `iat`, `exp` | seconds since epoch; `exp = iat + 600` |
| `jti` | 16 random bytes, b64url |
| `username` | Velora username |
| `display_name` | currently the same as username |
| `pfp` | absolute URL or null |
| `scp` | array drawn from `"chat"`, `"voice"`, `"media"`, `"sign"`; each is present only if the Velora token holds `CHAT`, `VOICE`, `MEDIA_UPLOAD` or `SIGN_MESSAGES` respectively |

Errors:
- `invalid_instance`: the URL doesn't parse, or it's http outside dev.
- `insufficient_scope`: the standard Velora 403.

### 2.3 Account signing key (message signing)
New Velora scope: **`SIGN_MESSAGES = 32768`** ("Sign messages as you"). It counts as dangerous, so it's unchecked by default on the consent screen.

Each Velora account has **one** active Ed25519 signing key, shared by every app and browser the person uses. Velora keeps the private half encrypted at rest (AES-256-GCM, with a key file outside the repository) and gives it only to a token that holds `SIGN_MESSAGES`. Per-device key registration (`POST /bonfire/keys`) is retired.

| route | auth | result |
|---|---|---|
| `GET VELORA/bonfire/signing-key` | bearer + `SIGN_MESSAGES` | `{ kid, public_key, private_key, created_at }`: the active key, created on the first call. `Cache-Control: no-store` |
| `POST VELORA/bonfire/signing-key/rotate` | Velora **website session** only (not an app token) | revokes the active key, makes a new one, returns `{ kid, public_key, created_at }` |
| `GET VELORA/bonfire/keys/kid/:kid` | public | `{ kid, user_id, public_key, created_at, revoked_at }` or 404 `key_not_found` |
| `GET VELORA/bonfire/keys/user/:userId` | public | `{ user_id, keys: [ ... including revoked ] }` |

- `public_key` is the b64url of the raw 32-byte Ed25519 public key. `private_key` is the b64url of the PKCS#8 DER private key. Clients import it into WebCrypto as a **non-extractable** key, keep it in memory, and never store the raw bytes.
- `kid = "k_" + first 16 hex of sha256(raw public key)`.
- Clients fetch the key after sign-in and fetch it again when a sign attempt fails, on a 401, or when the instance rejects a signature. After a rotation the old key stops working and apps pick up the new one automatically.
- Rotation does not touch old messages: they stay valid because verification compares the key's `revoked_at` with the signature's `ts` (§8). Keys that older clients registered per device stay in the lookups as history, but no new ones can be created.
- Times are ms epoch numbers, and `revoked_at` is null while the key is active.

### 2.4 User instance list (syncs the rail across devices)
The client always keeps its list locally; when signed in with Velora it merges the local list with this one (union, server order first) and then keeps them in sync.
| route | auth | result |
|---|---|---|
| `GET VELORA/bonfire/instances` | bearer + `CHAT` | `{ instances: [ { url, position, added_at, muted, push } ] }` |
| `PUT VELORA/bonfire/instances` `{ instances: [ { url } ] }` | bearer + `CHAT` | replaces the whole list in this order (keeps each kept instance's `muted`/`push`); returns the list |
| `PATCH VELORA/bonfire/instances/prefs` `{ url, muted?, push? }` | bearer + `CHAT` | per-instance push consent (§12.3); returns that list entry, or 404 `instance_not_in_list` |

Each `url` is a normalized origin, and the list holds at most 100.

### 2.5 Bonfire web sign-in (separate token)
Bonfire on the web (`VELORA/chat`) never uses the main site's session token. It signs in like the apps do, through the consent screen, and keeps its **own** token (`localStorage['bonfire_token']`; project name `Bonfire (web)`):
1. Client makes a random `state` (16–128 chars `[A-Za-z0-9_-]`, kept in `sessionStorage`) and navigates to `VELORA/bonfire/app-login?client=web&state=<state>`.
2. Velora redirects to `/login?…&app=bonfire&client=web&state=…`. If already signed in on the site, the page offers the saved account (no password), then the consent screen.
3. On approve, the login page navigates to **`/chat#/signin?code=<code>&state=<state>`** (same origin only, hard-coded path, never a URL from the query).
4. Client checks `state` matches, then `POST VELORA/bonfire/app-exchange { code, state }` → `{ token, username, scopes, version }`, stores it, clears the hash.
Desktop/Android keep their existing `bonfire://` flow and token storage. Signing out of Bonfire revokes only Bonfire's token.

### 2.6 Legacy export
`GET VELORA/chat/servers/:sid/export` takes a bearer with `CHAT`, and only the **owner** may call it. It returns `application/zip` in the format of §9. Users in the export are principals of the form `v:<users.id>`.

---

## 3. Instance discovery

`GET INSTANCE/.well-known/bonfire` is public and returns:
```json
{
  "software": "bonfire-server", "version": "0.1.0", "protocol": 1,
  "name": "My Instance", "description": "", "icon_url": null,
  "public_url": "http://localhost:4100",
  "accounts_mode": "velora" | "local",
  "velora": { "issuer": "http://localhost:3000", "jwks_url": "http://localhost:3000/.well-known/bonfire/jwks.json" } | null,
  "claimed": true,
  "registration": "open" | "closed",
  "features": { "signing": true, "voice": false, "uploads": true, "youtube": false },
  "max_upload_mb": 25,
  "community": { "sid": "s…", "name": "…", "icon_url": null, "description": "", "member_count": 3, "join_policy": "open" | "request" } | null
}
```
- `registration` applies only to local mode.
- `features.signing` is false in local mode. `features.youtube` is true only when the optional yt-dlp player works (§15).
- `community` is the instance's one community (always shown, it's what the URL is for), or `null` while the instance is unclaimed / not set up yet.
- `name` / `description` / `icon_url` mirror the community once it exists.

---

## 4. Instance authentication

In both modes the client ends up holding an **instance session token**. It's 32 random bytes, b64url, stored server-side as sha256. It lasts 30 days from last use and can be revoked. The client sends it as `Authorization: Bearer <session>` on REST calls and in the WS `auth` frame.

| route | body | result |
|---|---|---|
| `POST /api/v1/auth/velora` (velora mode) | `{ token: <instance jwt> }` | `{ session, user }` |
| `POST /api/v1/auth/register` (local mode, registration open, or instance unclaimed) | `{ username, password }` | `{ session, user }` |
| `POST /api/v1/auth/login` (local mode) | `{ username, password }` | `{ session, user }` |
| `POST /api/v1/auth/logout` | – | `{ ok: true }` |
| `GET /api/v1/me` | – | `{ user, instance_admin, instance_owner, scopes }` |

How the instance checks a JWT:
1. The signature verifies against JWKS from the configured `velora_url`.
2. `iss` equals `normalizeOrigin(velora_url)`.
3. `aud` equals `normalizeOrigin(public_url)`.
4. `exp` is in the future, with 60s of skew allowed.
5. The `jti` hasn't been seen before.

On success it upserts the principal, refreshing `username`, `display_name` and `pfp`. The session remembers `scp`: without `"chat"` the instance refuses the login with `insufficient_scope`, and without `"sign"` the instance refuses signed messages from that session.

Local mode rules:
- Usernames are 2–32 characters of `[a-z0-9_.]`, case-insensitive and unique.
- Passwords are 8–200 characters, hashed with `crypto.scrypt` (N=16384, r=8, p=1, 16-byte salt) so there's no native dependency.

**User object** (every place a user appears):
```json
{ "id": "v:123" | "l:7", "kind": "velora" | "local", "username": "nat", "display_name": "nat", "pfp": "https://…" | null, "velora_id": "123" | null }
```
The principal string is **the** user id in every instance payload: authors, members, reactions, mentions and bans.

A third principal kind is the **bot** (`b:<n>`, `"kind": "bot"`): its user object carries `"bot": true` (clients show the BOT tag). Bots never hold sessions or log in; they use bot tokens (§14).

---

## 5. Claiming and instance administration

**Claim.** On first boot an unclaimed instance writes a setup code (`XXXX-XXXX`, Crockford base32) to stdout and to `DATA_DIR/setup-code.txt`. An authenticated user claims it with `POST /api/v1/instance/claim { code }`, which returns `{ ok: true }`. That user becomes the instance owner and an admin, and the code file is deleted.

If the env var `BONFIRE_OWNER=v:<velora id>` is set, the instance boots already claimed by that user. While unclaimed, local-mode registration is always allowed so the first user can create an account.

**Settings.** `GET /api/v1/instance/settings` (admins) returns the settings below; `PATCH` with a partial object updates them.

| setting | type | notes |
|---|---|---|
| `name`, `description`, `icon_url` | string | |
| `public_url` | origin | |
| `accounts_mode` | `"velora"` / `"local"` | **requires restart**; existing principals of the other kind can no longer log in |
| `velora_url` | origin | default `https://velora.ikelene.net` |
| `registration` | `"open"` / `"closed"` | local mode |
| `max_upload_mb` | int 1–500 | instance ceiling |
| `voice` | `{ cf_app_id, cf_app_secret, cf_turn_key_id, cf_turn_token }` | secrets are **write-only**; GET returns `{ cf_app_id, has_app_secret, cf_turn_key_id, has_turn_token }` |
| `youtube` | `{ enabled, ytdlp_path, cache_dir, cache_max_gb }` | optional player, §15. Defaults `true`, `"yt-dlp"` (on PATH), `""` (= `DATA_DIR/cache/yt`), `5` |

The settings live in `DATA_DIR/config.json`, a file you can edit by hand. The instance watches it and reloads it, and API writes rewrite it. `DATA_DIR/config.json` is the source of truth for these keys.

### 5a. One community per instance
- An instance has **at most one** community. The instance owner (or an admin) creates it once, during setup: `POST /api/v1/servers { name }` or `POST /api/v1/import` (zip). A second create/import → `409 community_exists`; anyone who isn't an instance admin → `403 forbidden`.
- The instance's `name` / `description` / `icon_url` and the community's are the **same values**: patching either side updates both.
- The instance owner is the community owner. Deleting the community (`DELETE /servers/:sid`, owner) returns the instance to the "not set up" state (`community: null`), so it can be created or imported again.
- Joining = `POST /servers/:sid/join` (follows `join_policy`) or an invite code. There is no auto-join setting any more.

**Other admin routes:**
- `POST /api/v1/instance/restart` (admins) returns `202 { ok: true }`. The instance broadcasts `{type:"instance_restarting"}`, closes its sockets, and calls `process.exit(75)`. The supervisor (docker `--restart unless-stopped`, systemd `Restart=always`, or the dev script) starts it again.
- `GET /api/v1/instance/admins` returns `{ admins: [user…], owner: user }`. `PUT /api/v1/instance/admins/:uid` and `DELETE /api/v1/instance/admins/:uid` are owner-only.

---

## 6. Communities: REST (compatibility rule)

**Rule:** every endpoint below uses the same path as Velora's current `routes/chat.js`, with the `/chat` prefix replaced by `/api/v1`. It has the same request body and the **same response JSON shape** as Velora returns today. The only difference is that user ids are principal strings (§4).

A server/community object gains these fields:
- `join_policy`: `"open"` or `"request"`
- `allow_signing`: bool
- `require_signing`: bool
- `allow_uploads`: bool
- `upload_max_mb`: int
- `listed`: bool
- `instance`: the normalized origin of the instance

Core subset for v1:
- **Servers:** `GET/POST /servers`, `GET/PATCH/DELETE /servers/:sid`, `PUT /servers/:sid/layout`, `POST /servers/:sid/join`, `POST /servers/:sid/leave`, `GET /invite/:code` (public), `POST /join/:code`, `POST/DELETE /servers/:sid/icon|banner`
- **Members:** `GET /servers/:sid/members`, `DELETE /servers/:sid/members/:uid` (`?ban=1`), `DELETE /servers/:sid/bans/:uid`, `GET /servers/:sid/bans`
- **Roles:** CRUD on `/servers/:sid/roles[/:rid]`, `PUT /servers/:sid/roles/order`, `PUT/DELETE /servers/:sid/members/:uid/roles/:rid`
- **Channels:** `POST /servers/:sid/channels`, `PATCH/DELETE /channels/:cid`, `PUT /channels/:cid/perms`
- **Messages:** `GET/POST /channels/:cid/messages`, `POST /channels/:cid/read`, `PATCH/DELETE /messages/:id`, `PUT/DELETE /messages/:id/reactions/:emoji`, `PUT/DELETE /messages/:id/pin`, `GET /channels/:cid/pins`, `GET /channels/:cid/search`
- **Identities and settings:**
  - `GET /identities?ids=` takes principal ids and returns `{ users: [user…] }`.
  - `GET/PATCH /settings` stores the user's per-instance settings, e.g. `server_order`.
- **Emojis:** `GET /servers/:sid/emojis`, `POST /servers/:sid/emojis` (multipart `file`, `name`), `DELETE /servers/:sid/emojis/:eid`

Member routes take the principal id (`:uid`) where Velora took a username.

Also ported from Velora with the same paths and shapes (details in the sections named):

| area | routes |
|---|---|
| Channel types (§6.1) | `POST /servers/:sid/channels` and `PATCH /channels/:cid` accept `type` + `config` |
| Roles shop | `GET /channels/:cid/shop`, `POST/DELETE /channels/:cid/shop/:rid` |
| Starboard | `GET /channels/:cid/starboard[?before=<starred_at>]` |
| Webhooks (§13) | `GET/POST /channels/:cid/webhooks`, `PATCH/DELETE /hooks/:wid`, `POST /hooks/:wid/avatar`; execute: `/webhooks/:wid/:token` |
| Soundboard (§6.2) | `GET /sounds`, `GET/POST /servers/:sid/sounds`, `PATCH/DELETE /servers/:sid/sounds/:id` |
| Link previews (§6.3) | `GET /unfurl?url=` |
| Bots (§14) | `GET/POST /bots`, `GET /bots/by-name/:username`, `POST /bots/by-name/:username/add`, `PATCH/DELETE /bots/:id`, `POST /bots/:id/avatar`, `POST /bots/:id/token` |
| Notifications | `GET /notify`, `PUT /notify/:target` (`{ level: default|all|mentions|none, mute_minutes: 0 unmute | -1 forever | n, push }`) |
| Search | `GET /servers/:sid/search?q=` with `from:name`, `in:channel`, `has:image|video|file|link|embed|sound|audio` (voice, link, roles-shop and starboard channels are never searched) |
| Emojis | `GET /emojis/:eid/info` |
| YouTube (§15) | `POST /yt/:id/prepare`, `GET /yt/:id/status`, `POST /yt/:id/save`, `GET /yt/stream/:id` |

### 6.1 Channel types

`type` is one of `text`, `voice`, `logs`, `roles`, `welcome`, `link`, `starboard`. (`game`, Velora's Minecraft channel, is **not** accepted yet: it falls back to `text`.) Anything else is `text`. `config` is validated and cleaned per type (Manage channels; the response shows the cleaned value):

| type | `config` | posting |
|---|---|---|
| `text` | `{}` | needs Send (and not locked) |
| `voice` | `{ allow_call_in, user_limit 0–99 }` | no chat |
| `logs` | `{}` - webhooks post here (§13) | only Manage messages (and webhooks / bots with the permission) |
| `welcome` | `{ allow_chat, join: [template…], leave: [template…] }`; a template contains `{user}` (and may use `{server}`, `{count}`), ≤ 20 of ≤ 200 chars, others are dropped | Manage messages, unless `allow_chat`; the instance posts a system line (`sys_kind` `join` / `leave`, with the `subject` account) here when someone joins or leaves, using the templates or a built-in default |
| `link` | `{ url }` (http/https, else `400 bad_link`) | no chat |
| `roles` | `{ items: [{ rid, price 0–1000000, desc ≤ 200 }] }` ≤ 25, roles must be below yours and not Administrator (`shop_admin_role`), needs Manage roles | no chat |
| `starboard` | `{ watch: [cid…] (none = every text/welcome/logs channel), min 1–100 (default 3) }` | no chat |

A locked channel always needs Manage messages. `can_post` in `GET /servers/:sid` reflects all of this.

**Roles shop.** `GET /channels/:cid/shop` → `{ items: [{ role, price, desc, has, owned }], balance: null, owner_free }` (`balance` is null: the instance has no credits). `POST /channels/:cid/shop/:rid` self-assigns a **free** role; for a priced role (and you are not the owner) it answers `402 { "error": "payment_unavailable" }` (a later wave adds paying through Velora). `DELETE` gives the role back. Both return the shop view and push `chat_member_update` + `chat_perms_changed`.

**Starboard.** The ⭐ reaction is the vote. When a message in a watched channel reaches `min` stars it is added to the board and stays (only deleting the message or channel removes it). `GET /channels/:cid/starboard` → `{ recent: [message + { channel_name, starred_at, stars, starred }], more, top, throwback, total, min, watching }`; `?before=<starred_at>` pages back and returns only `{ recent, more }`. Entries from channels you cannot see are left out.

### 6.2 Soundboard

Sounds belong to the community: `GET /servers/:sid/sounds` → `{ sounds: [{ id, name, emoji, volume, duration, url }], max: 30 }`; `GET /sounds` → `{ servers: [{ sid, name, icon, sounds }] }`. `POST /servers/:sid/sounds` (Manage server, multipart `file`, optional `name`, `emoji`) stores the file under `/uploads/sounds/`. The instance has no transcoder: the file must be **mp3, wav, ogg, flac or m4a** (checked by magic bytes, duration read from the headers) and **at most 5.2 s** (errors `not_audio`, `sound_too_long`, `too_many_sounds`, `file_too_large`; 8 MB ceiling). `PATCH` takes `name`, `emoji`, `volume` (5–100). Playing is a gateway frame, §7.

### 6.3 Link previews

`GET /unfurl?url=<url>` (session required, 60 / minute / user) → `{ embed }`, where `embed` is `null` when there is nothing to show, or:
- `{ type: "link", url, site, title, description, color?, image, large }`, from OpenGraph / Twitter tags (falling back to oEmbed discovery); `image` is re-hosted at `/uploads/embeds/…` so viewers never contact the site;
- `{ type: "youtube", id, url, title, channel, image }` for YouTube links.

The fetch is **SSRF-safe**: http(s) only, ports 80 / 443 only, no credentials in the URL; the host is resolved and refused if *any* address is private, loopback, link-local, metadata (169.254.169.254), CGNAT, multicast or reserved, in IPv4 or IPv6 (including IPv4-mapped, NAT64 and 6to4 forms, and numeric host spellings like `2130706433`); the connection is pinned to the address that was checked; redirects are followed manually (max 3) and every hop is re-validated; limits are 1 MB per page, 5 MB per picture, 7 s per hop, 10 s total. Results are cached in SQLite (24 h, failures 1 h). Velora-specific cards (invites, profiles) are not made here.

New in v1:

| route | who | result |
|---|---|---|
| `GET /servers/:sid/requests` | `KICK` or `MANAGE_SERVER` | `{ requests: [ { user, message, created_at } ] }` |
| `POST /servers/:sid/requests/:uid/accept` / `…/deny` | same | `{ ok: true }` |
| `POST /servers/:sid/join` when `join_policy=request` | anyone not banned | `{ pending: true }`; a second call returns the same |
| `GET /servers/:sid/invites` | `MANAGE_SERVER` | `{ invites: [ { code, created_by, created_at, expires_at, max_uses, uses } ] }` |
| `POST /servers/:sid/invites` `{ expires_in?: seconds, max_uses?: int }` | `MANAGE_SERVER` | invite object |
| `DELETE /invites/:code` | `MANAGE_SERVER` | `{ ok: true }` |
| `GET /servers/:sid/export` | owner | `application/zip` (§9) |
| `POST /import` multipart `file` | instance admins, only while the instance has no community (§5a) | `{ sid }` |

Invites behave like this:
- **An invite code always admits** you, even when `join_policy=request`. That's the "anyone with the link" path.
- A bare `POST /servers/:sid/join` follows `join_policy`.
- Every community keeps its legacy permanent `invite_code` field too. `PATCH { new_invite: true }` regenerates it, as before.

Permission bits are the same as Velora's `chat.js:42-49`:

| bit | value | bit | value |
|---|---|---|---|
| SEND | 1 | BAN | 32 |
| MANAGE_CHANNELS | 2 | MANAGE_MESSAGES | 64 |
| MANAGE_SERVER | 4 | MENTION_EVERYONE | 128 |
| MANAGE_ROLES | 8 | ATTACH | 256 |
| KICK | 16 | ADMIN | 512 |
| | | VIEW (channel-only) | 1024 |

The permission algorithm is the same as `permsOf` / `channelPermsOf` / `canView` / `canPost`. The community owner has all permissions. **Instance admins have no implicit power inside communities** unless they're a member with roles. The one exception is that instance admins may delete the community (returning the instance to setup).

---

## 7. Gateway (WebSocket)

Connect to `ws(s)://INSTANCE/gateway`.

**Handshake**
1. The client sends `{ "type": "auth", "session": "<instance session>" }` within 10 seconds.
2. The server replies `{ "type": "auth_success", "user": <user>, "instance_admin": bool, "instance_owner": bool }`, or closes with `4001` (`invalid_session`).
3. The client sends `{ "type": "chat_hello" }`. The server replies `{ "type": "chat_ready" }` and starts sending community events.
4. The client sends `{ "type": "ping" }` every 25 seconds. The server answers `{ "type": "pong" }` and drops any socket that has been idle for more than 60 seconds.

**Client to server** frames have the same names and fields as Velora today:
- `chat_send { nonce, channel, message, reply_to?, attachments?, signature? }`. The server replies `chat_ack { nonce, message }` or `chat_error { nonce, error }`.
- `chat_typing { channel }`
- `chat_read { channel, message_id }`
- the `chat_rtc_*` family (§10)

**Server to client** events have the same names and shapes as Velora today:
- Messages: `chat_message`, `chat_message_update`, `chat_message_delete`, `chat_reactions`, `chat_typing`, `chat_pins_update`
- Server and roles: `chat_server_update`, `chat_server_removed`, `chat_roles_update`, `chat_perms_changed`
- Channels and members: `chat_channels_update`, `chat_member_update`, `chat_members_stale`, `chat_emojis_update`
- Identity: `chat_identity_update`
- Replies and errors: `chat_ack`, `chat_error`, `chat_ephemeral`
- Mentions: `chat_mention { id, server, sid, channel, cid, from, pfp, body }`, sent only to the people a message pings who are online (their `@name`, a reply to them, `@everyone`, `@here` (online members only), a role they hold, or every message if their level is `all`), minus muted / `none` settings. Everyone else goes to the server-side `notifyOffline(userIds, payload)` hook (no-op for now; push arrives in a later wave).
- Starboard: `chat_starboard { server, channel (the board), id (message), stars, added? }` when a watched message's stars change (`added: true` the moment it first lands on the board)
- Voice: `chat_voice_state` and the rtc replies
- Soundboard: the client sends `{ type: "voice_sound", sound: "<sound id>" }` while in a voice room (needs the `voice` scope); every socket in that room, the sender included, gets `{ type: "voice_sound", by: "<username>", channel: "<cid>", sound: { id, name, emoji, volume, duration, url } }`. Failures come back to the sender only as `{ type: "voice_sound_failed", reason }` with `not_in_voice`, `not_found`, `not_allowed`, `too_fast` (one sound per 1.2 s) or `insufficient_scope`.

New events:
- `chat_join_request { sid, request }` goes to members who can accept.
- `chat_join_result { sid, accepted }` goes to the requester.
- `chat_server_added { server }` is sent when you join or are accepted (or the community is created for you as its owner).
- `instance_update { settings: <public subset> }`
- `instance_restarting {}`

**Fan-out** is per community. Each socket subscribes to the communities its user belongs to, and a member only receives an event if they can view its channel. Instances don't relay presence: the client gets Velora users' presence from its Velora home socket.

**Close codes:**

| code | meaning |
|---|---|
| 4001 | invalid or expired session |
| 4003 | banned from instance |
| 4008 | rate limited |
| 4010 | instance restarting |

---

## 8. Message signing

Signing is available only in velora mode, only to sessions whose `scp` contains `"sign"`, and only in communities with `allow_signing=true`.

**What the client signs:** the UTF-8 bytes of `"bonfire-msg-v1\n" + canonical(payload)`.
- `canonical` means JSON with object keys sorted recursively, no whitespace, and numbers as integers.
- `payload` has these fields:
```json
{
  "v": 1,
  "iss": "<normalized velora origin>",
  "instance": "<normalized instance origin>",
  "community": "<sid>",
  "channel": "<cid>",
  "author": "<velora user id string>",
  "ts": <ms epoch int>,
  "nonce": "<b64url 16 random bytes>",
  "body": "<exact message text>",
  "attachments": ["<sha256 hex>", ...],
  "reply_to": "<message id string>" | null,
  "edit_of": "<message id string>" | null
}
```
`attachments` holds one sha256 per attachment, in message order. Each comes from the upload response (§11).

**How the client sends it.** `chat_send` and `POST /channels/:cid/messages` carry `signature: { kid, sig, ts, nonce }`, where `sig` is the b64url of a 64-byte Ed25519 signature. An edit, `PATCH /messages/:id { message, signature }`, uses `edit_of = id`. (The text field is `message`, as in Velora's routes; the instance also accepts `body` as an alias on REST.)

**How the instance verifies it** (unchanged by the single account key: a signature is still checked by `kid`, and a key revoked before `ts` is rejected):
1. It rebuilds the payload from the stored fields.
2. It fetches the key from `VELORA/bonfire/keys/kid/:kid` and caches it for 10 minutes.
3. It requires that `key.user_id == author.velora_id`.
4. It requires that the key wasn't revoked before `ts`.
5. It requires that `|ts - now| ≤ 5 min`.
6. It verifies the signature.

If verification fails, the instance rejects the message with `bad_signature`. If the community has `require_signing=true`, unsigned messages from velora principals get `signature_required`. Bots, webhooks and system messages are exempt.

**What the API returns.** Each message gains `signature: { kid, sig, ts, nonce } | null` and `verified: true | false | null`. `null` means unsigned. **Clients verify independently** against Velora keys, so they don't trust `verified`. An edit without a signature clears `signature` and `verified`. Exports keep signatures, and so does a later re-import.

---

## 9. Export format `bonfire-export-v1` (zip, built with `fflate`)

| path | contents |
|---|---|
| `manifest.json` | `{ format: "bonfire-export-v1", source: "<origin>", source_kind: "instance" \| "velora-legacy" \| "velora-import", exported_at: <ms>, community: "<sid>" }` |
| `community.json` | `{ name, description, icon, banner, settings: {join_policy, allow_signing, require_signing, allow_uploads, upload_max_mb}, categories: [name…], channels: [ {cid, name, topic, category, position, locked, type, config, perms: [ {role: "<rid>", allow, deny} ]} ], roles: [ {rid, name, color, position, permissions, hoist, mentionable, is_default} ], emojis: [ {eid, name, animated, file} ], invites: [ {code, expires_at, max_uses} ] }` |
| `members.jsonl` | one JSON object per line: `{ user: <user object>, roles: ["<rid>"…], joined_at, owner?: true }` |
| `messages/<cid>.jsonl` | oldest first, one JSON object per line: `{ id, author: <user object> \| null, author_name?, author_avatar?, body, attachments, embeds?, reply_to, created_at, edited_at, system, sys_kind?, pinned, reactions: [ {emoji, users: [uid…]} ], signature?, bridge? }` |
| `files/<path>` | icon, banner, emojis, and locally hosted attachments, referenced as `files/…` from the JSON |

Import rules:
- The importer recreates the community with new ids and maps old ids to new ones for channels, roles, messages (including `reply_to`) and emojis.
- The **owner of the import is whoever runs it**. The exported owner flag is kept only as a hint.
- `v:` principals keep their identity. `l:` principals from another instance become **name-only authors**: `author_name` and `author_avatar` are set and there is no account.
- On a velora-mode instance, members whose principal is `v:` are recreated as members with their roles.
- Channel `config` of the typed channels (§6.1) is carried over: link `url`, welcome templates, starboard `watch` (channel ids remapped) and shop `items` (role ids remapped). `game` channels become text channels.

---

## 10. Voice

Voice uses the same `chat_rtc_*` protocol Velora has today (`chat_rtc_join`, `publish`, `connected`, `subscribe`, `answer`, `close`, `ice` and `leave`, plus `chat_rtc_joined`/`published`/`offer`/`ready`/`room` and `chat_voice_state`). It runs over the instance gateway, and rooms are named `bf_<cid>`.

The instance calls Cloudflare Realtime with the keys in its `voice` settings. If no keys are configured, `chat_rtc_join` returns `chat_error { nonce, error: "voice_unavailable" }`. A Velora voice broker will come in a later version.

DM calls (`bfc_…`) stay on Velora.

---

## 11. Uploads

`POST /api/v1/media/upload` takes a multipart field `file` and requires the community setting `allow_uploads`. The `sid` query parameter is required, so the instance can check the per-community limit.

Response:
```json
{ "url": "INSTANCE/uploads/<yyyy>/<mm>/<random>.<ext>", "name": "…", "size": 123, "mime": "image/png", "type": "image|gif|video|audio|file", "sha256": "<hex>", "width"?: n, "height"?: n }
```

- Message attachments are `{ url, type, name, size, width?, height?, sha256 }`, with at most 10.
- The instance accepts only URLs that are its own `/uploads/…` or Klipy GIF URLs.
- `sha256` is the hash of the **stored** bytes, which is what the client hashes when it signs.
- The instance doesn't re-encode images in v1 because it has no native dependency. It strips JPEG EXIF via a byte-level APP1 drop and checks the type against the file's magic bytes.
- Size is limited to `min(community.upload_max_mb, instance.max_upload_mb)`.
- Files are served with `Cache-Control: public, max-age=31536000, immutable` and `X-Content-Type-Options: nosniff`. Non-media types are served with `Content-Disposition: attachment`.

---

## 12. Velora relays

Services an instance asks Velora for: registering, push, credit payments, daily credits, the voice broker, import bundles and the public directory. People and the public call the matching routes under `VELORA/bonfire/*`. Everything an instance calls is **signed with the instance's Ed25519 key** (§12.2). Velora never fetches an instance-supplied URL. Dev: `http` instance urls need `BONFIRE_DEV=1` on Velora (as in §1); public urls stored for the directory must be `https`.

### 12.1 Registration
The instance has an Ed25519 key (`DATA_DIR/keys/instance.key`). Its **`instance_id`** is `ik_` + first 16 hex of `sha256(raw 32-byte public key)`. `pubkey` is the b64url of the raw 32 bytes (same encoding as the signing key, §2.3). `url` is the instance's `public_url` (normalized as in §1).

1. `POST VELORA/bonfire/instances/challenge` `{ pubkey, url }` -> `{ nonce, expires_in: 300 }` (single use).
2. `POST VELORA/bonfire/instances/register` `{ pubkey, url, name, accounts_mode: "velora"|"local", nonce, sig }` where `sig` = b64url Ed25519 over the UTF-8 string `bonfire-register-v1|<nonce>|<normalized url>` -> `{ instance_id, trusted, voice: { cap_minutes, used_minutes } }`.

- Upserts by key hash, so re-registering updates `url`, `name` and `accounts_mode` (call it on every start). `cap_minutes` is `null` when unlimited (trusted).
- `Authorization: Bearer <Velora token>` is optional. A valid one records that account as the instance **owner**, who receives pay-request payments (§12.5).
- Errors: `invalid_pubkey`, `invalid_url`, `invalid_nonce`, `bad_signature` (401), `invalid_accounts_mode`, `invalid_name`, `url_taken` (409, another key owns that url), `instance_banned` (403). Rate limited per IP (429 `rate_limited`).
- `name` is stored with control characters and `<>` stripped, max 80 characters. Registration does **not** prove control of the url. An admin can remove a squatted registration.
- `trusted` is set only by Velora staff (for `chat.ikelene.net` and hosted instances). It unlocks §12.4 and unlimited voice.
- `instance-token` (§2.2) refuses audiences that are banned (403 `instance_banned`).

### 12.2 Signed requests (instance -> Velora, all `VELORA/bonfire/relay/*`)
Headers:
```
X-Bonfire-Instance: <instance_id>
X-Bonfire-Ts:       <unix ms>
X-Bonfire-Sig:      b64url( Ed25519( METHOD "|" path "|" ts "|" sha256hex(body) ) )
```
- `METHOD` is upper case. `path` is the request target exactly as sent: the path **with** its query string (`/bonfire/relay/import/bundle?ticket=bit_...`). `body` is the exact bytes sent (empty for GET, so the hash is `e3b0c442...b855`). Send JSON bodies with `Content-Type: application/json`.
- `ts` must be within **60 s** of Velora's clock (401 `stale_timestamp`). Each signature is accepted **once** (401 `replayed`), so sign every request freshly.
- Other errors: 401 `unknown_instance` / `bad_timestamp` / `bad_signature`, 403 `instance_banned`, 429 `rate_limited` (with `Retry-After`), 400 `invalid_json`, 413 `payload_too_large` (bodies are at most 300 KB).
- The relay router reads the raw body itself, ahead of Velora's global JSON parser and xss-clean, so strings are never rewritten before the hash is checked. Responses are normal JSON.
- Limits are per instance: 1500 requests/min overall, plus the route limits below.

### 12.3 `POST /bonfire/relay/notify` (offline push)
```json
{ "user_id": "123", "kind": "mention" | "reply" | "dm_like", "community_name": "…", "channel_name": "…", "title": "nat mentioned you", "preview": "…", "url": "INSTANCE/…" }
```
- `user_id` is the Velora id (`sub` of the token). `title` max 100, `preview` max 300, names max 80. `url` is optional and must be on the instance's own origin (400 `invalid_url`).
- Result: `{ "delivered": true }` or `{ "delivered": false, "reason": "not_subscribed" | "muted" | "push_off" | "held" }`. It always returns 200 for those cases.
- **Consent:** only if the user has this instance's url in their list (§2.4), `muted` is false and `push` is true. People change this with `PATCH /bonfire/instances/prefs`.
- Delivery matches Velora's own mentions: the Android notification socket plus browser push, with the "quiet while you're here" hold. While the person is actively using Bonfire somewhere, the push is `held` and sent after they go idle (relayed pushes can't be checked for "read", so they are dropped after 2 hours).
- Tapping the push opens Bonfire at that instance (`/chat#/i/<instance>`).
- Limits: 600/min per instance, 20/min per instance and user (429 `user_rate_limited`).

### 12.4 `POST /bonfire/relay/daily` (trusted only)
`{ "user_id": "123" }` -> `{ "status": "claimed", "amount": 5 }` | `{ "status": "already" }` | `{ "status": "banned" }`. This is the same once-a-day credit as Bonfire/Fluxer chat (`source: bonfire`; 15 for Pro or staff). Untrusted instances get 403 `not_trusted`.

### 12.5 Credit payments (pay requests)
`POST /bonfire/relay/pay-request` `{ user_id, amount, reason, ref }` -> `{ id, status: "pending", approve_url, amount, expires_at }`.
- `amount` is an integer from 1 to 100000. `reason` max 200 is shown on the approval page. `ref` (required, max 100) is the instance's own reference, e.g. `role:<rid>`. Sending the same `ref` again returns the same request (a different user or amount gives 409 `ref_reused`).
- The user must have the instance in their list (403 `not_subscribed`). Other errors: `invalid_amount`, `invalid_ref`, `user_not_found` (404), `self_payment`, `too_many_requests` (429, five open requests per user), `payee_unavailable` (503).
- **Payee:** the instance **owner's Velora account** when registration recorded one (§12.1). Otherwise Velora's own account (`BONFIRE_HOUSE_USER`, default the first owner-rank account). Credits are never burned.
- The request is a normal Velora payment request that lives 30 minutes. The person opens `approve_url` (`VELORA/payment/<id>`: the existing Pay / Cancel page with the captcha). Alternatively `POST VELORA/bonfire/pay-requests/:id/approve` (bearer + `CURRENCY_PAY` + captcha like `/currency/transfer`) and `POST VELORA/bonfire/pay-requests/:id/decline` (bearer, only the payer).
- `GET /bonfire/relay/pay-request/:id` -> `{ id, status: "pending"|"paid"|"declined"|"expired", amount, ref, receipt, paid_at?, error? }`. Only the requesting instance can read it (else 404). Poll every few seconds. `declined` covers cancelled and failed (then `error` is set). Credits move before `paid` is reported.
- **Receipt** (`status: "paid"` only): an EdDSA JWS signed with Velora's key (the JWKS key of §2.1), verifiable offline:
  - header `{ "alg": "EdDSA", "typ": "bonfire-receipt+jwt", "kid": <jwks kid> }`
  - claims `{ iss: <Velora issuer>, aud: <instance url>, sub: "<user id>", amount, ref, paid_at: <ms>, rcp: "<request id>", iat, exp }` (`exp` is about a year)
  - The instance MUST check the signature against the JWKS, `typ` is exactly `bonfire-receipt+jwt`, `aud` is its own `public_url`, `ref`/`amount`/`sub` match what it asked for, and `rcp` has not been used before. Receipts must never be accepted as login tokens (§2.2 tokens have `typ: "JWT"`), and login verification should reject any other `typ`.

### 12.6 Import bundles
For importing a Discord / Fluxer server into a self-hosted instance. The person uses their **Velora** token (it works for local-account instances too), so the user routes take a bearer with `CHAT`:

| route | result |
|---|---|
| `GET VELORA/bonfire/import/platforms` | `{ platforms: [ { id, name, ready, bot, invite, linked } ] }` |
| `GET VELORA/bonfire/import/:platform/guilds` | `{ guilds: [ { id, name, icon } ] }` the person can manage (needs the linked account; `not_linked`, `bot_not_in_server`, `not_your_server`) |
| `GET VELORA/bonfire/import/:platform/guilds/:gid` | the picker preview: `{ guild, groups: [ {name, channels: [ {id, name, topic, kind, skip, private, locked} ]} ], roles, emojis, … }` |
| `POST VELORA/bonfire/import` `{ platform, guild_id, channels: [id…], roles: [id…], options?: { name, icon, banner, emojis }, instance }` | `{ job_id, ticket, instance, expires_at }` |
| `GET VELORA/bonfire/import/:job_id` | `{ job_id, status: "queued"\|"running"\|"done"\|"failed", progress (0-100), stage, error, instance, size, expires_at, downloaded }` (owner only) |

- The job runs in the background (one per person at a time: 429 `import_running`; at least one channel is required: `pick_a_channel`). It builds a **`bonfire-export-v1` zip** (§9) with `source_kind: "velora-import"`: channels (with categories, voice channels and per-role view/send/attach settings), roles with their permissions, `@everyone` (rid `everyone`, `is_default`), emojis, icon and banner. It contains **no members or messages**: `members.jsonl` and `messages/<cid>.jsonl` are empty, so history stays where it is. `cid`s are `c<platform id>`, role `rid`s are `r<platform id>`.
- **`ticket`** (`bit_…`) is a one-time secret, shown only in the `POST` response and bound to the normalized `instance` url. The client hands it to the instance.
- Instance route: `GET /bonfire/relay/import/bundle?ticket=<ticket>` (signed, §12.2) -> `application/zip`. Errors: 404 `ticket_invalid`, 403 `ticket_wrong_instance` (the signing instance's url must equal the ticket's), 409 `not_ready` (retry), 410 `ticket_expired` (already downloaded, or older than 1 hour after the bundle was ready), 410 `import_failed`. **One download:** the ticket is spent when the download starts and the file is deleted afterwards. If a transfer fails, run the import again.

### 12.7 Voice broker
`POST /bonfire/relay/rtc/*`, `GET /bonfire/relay/rtc/ice`, wrapping Cloudflare Realtime. The keys stay on Velora. The bodies mirror what `chat_rtc_*` does today, with Cloudflare's names. Limit: 1200/min per instance, at most 400 open sessions.

| route | body | result |
|---|---|---|
| `POST /rtc/session` | `{}` | `{ sessionId, voice }` (a new SFU session) |
| `POST /rtc/tracks` | publish: `{ sessionId, sessionDescription: {type:"offer", sdp}, tracks: [ {mid, trackName} ] }`; subscribe (no description): `{ sessionId, tracks: [ {sessionId, trackName} ] }` | Cloudflare's reply (`sessionDescription`, `tracks` with per-track errors) |
| `POST /rtc/renegotiate` | `{ sessionId, sessionDescription: {type:"answer", sdp} }` | `{}` |
| `POST /rtc/close` | `{ sessionId, mids?: [mid…] }` | with `mids`: closes those tracks. Without: **ends the session** and stops its metering -> `{ ok, voice }` |
| `POST /rtc/heartbeat` | `{ sessionIds: [id…] }` | `{ alive, voice }` |
| `GET /rtc/ice` | | `{ iceServers }` |
| `GET /rtc/usage` | | `{ cap_minutes, used_minutes, over }` |

- A session can only be used by the instance that opened it (404 `session_not_found`). Track names are `[A-Za-z0-9_.:-]{1,64}`, `mid`s `[A-Za-z0-9_-]{1,32}`, at most 30 tracks per call. Errors: 503 `voice_unavailable` (not set up on Velora), 502 `voice_upstream`, 402 `voice_cap_reached` `{ cap_minutes, used_minutes }`.
- **Metering:** Cloudflare sessions are metered **per instance, per calendar month (UTC)** in raw session-minutes. A session counts from `rtc/session` until `rtc/close` (without `mids`) or, if the instance disappears, until its last call or heartbeat (sessions silent for 10 minutes are closed automatically). A participant who has a publish and a receive session uses 2 minutes per minute, so create the receive session lazily. Every `rtc/*` call for a session counts as a heartbeat, but an idle but connected session needs `rtc/heartbeat` at least every 5 minutes (once a minute is recommended).
- **Cap:** trusted instances are unlimited. Others get `BONFIRE_VOICE_FREE_MINUTES` (default 3000) a month, or the per-instance override set by staff. At or over the cap, `rtc/session`, `rtc/tracks` and `rtc/ice` return `402 { error: "voice_cap_reached" }` (renegotiate, close and heartbeat still work). Fall back to the instance's own keys when configured (§10).

### 12.8 Bans
Velora staff can ban an instance by key (`ik_…`) or by url host (`chat.example.com`, or `*.example.com` for subdomains). A banned instance gets 403 `instance_banned` on every relay and registration, no instance tokens, and no directory listing.

### 12.9 Directory
`PUT /bonfire/relay/directory` (signed, 20/min):
```json
{ "listed": true, "name": "…", "description": "…", "icon_url": "https://…", "member_count": 12, "invite_url": "https://…", "tags": ["gaming"] }
```
- `listed: false` removes the listing (nothing else is needed). One listing per instance (one instance = one community).
- Validation: `name` required, max 80. `description` max 500. `icon_url` and `invite_url` are optional `https` urls without credentials, max 512. `member_count` is an integer 0-100000000. `tags` is at most 8, each max 24 characters, lower-cased, no commas. Control characters and `<>` are stripped from text. Errors: `invalid_listed`, `invalid_name`, `invalid_icon_url`, `invalid_invite_url`, `invalid_member_count`, `invalid_tags`. The response is `{ listed, hidden_by_staff? }`. Staff can hide a listing, and then the instance can't bring it back.
- `GET VELORA/bonfire/directory?q=<text>&page=<n>` is public (CORS `*`) and returns `{ page, page_size: 24, has_more, results: [ { id: <instance_id>, url, name, description, icon_url, member_count, invite_url, tags, trusted, updated_at } ] }`, sorted by `member_count`. `q` matches name, description and tags. Unlisted, staff-hidden and banned instances never appear. Clients must treat every field as untrusted text and open `invite_url` / `url` only as links.

### 12.10 Staff routes (not for instances)
`/admin/bonfire/*` (rank `admin` or `owner` only): `GET instances`, `PATCH instances/:key` `{ trusted?, voice_cap_override? }` (`null` = default cap), `DELETE instances/:key`, `POST directory/:key/delist|relist`, `GET|POST bans` `{ key_hash? | url?, reason }`, `DELETE bans/:id`. They are driven by Admin > Instances in the dashboard.

---

## 13. Webhooks

Management (needs Manage channels; only `text` and `logs` channels): `GET /channels/:cid/webhooks` → `{ webhooks: [ { wid, name, avatar, channel, url, created_by, created_at } ] }`; `POST /channels/:cid/webhooks { name }` (30 per community, `too_many_webhooks`); `PATCH /hooks/:wid { name?, avatar?, new_token?, channel? }`; `DELETE /hooks/:wid`; `POST /hooks/:wid/avatar` (multipart `file`). `url` is built from the instance's `public_url`:

    POST INSTANCE/api/v1/webhooks/:wid/:token

No login: the token is the key. The body is Discord's: JSON `{ content, username, avatar_url, embeds[] }`, or multipart with `payload_json` and files (`files[0]`, …; an embed image can say `attachment://name`, and then that file is not repeated as an attachment). Embeds are cleaned like Discord's (10 embeds, field / length limits, http(s) URLs only). `?wait=true` returns the message (`{ id, type, channel_id (the cid), content, embeds, webhook_id, attachments, author, timestamp }`), otherwise `204`. `GET` returns the webhook info `{ id, type: 1, name, avatar, channel_id, guild_id, token }`, `DELETE` removes it (`204`). Limit **30 posts / minute / webhook** (`429 { message, retry_after, global: false }`). Errors here use Discord's `{ message, code }` shape. Messages show an author `{ id: null, name_only: true, webhook: true, username, pfp }`; they are exempt from signing and do not ping anyone offline.

## 14. Bots

A bot is an instance-local account (principal `b:<n>`, BOT tag, no login, no DMs). People with **Manage server** (and instance admins) manage them: `GET /bots` → `{ bots: [ { id, username, pfp, description, public, servers, owner, created_at } ], max }`; `POST /bots { name, description }` (name `[A-Za-z0-9_.-]{2,32}`, unique) → `{ bot, token }`; `PATCH /bots/:id { name?, description?, public? }`; `POST /bots/:id/avatar`; `POST /bots/:id/token` (new token, closes its gateway sessions); `DELETE /bots/:id`; `GET /bots/by-name/:username` → `{ bot, can_add_to }`; `POST /bots/by-name/:username/add { sid }` puts it in the community (it is a normal member afterwards, so roles, kicks and channel permissions apply). `:id` may be `b:3` or `3`.

**Token:** `base64url(<n>) + "." + 40 random base64url chars`, shown once, stored as sha256. Used as `Authorization: Bot <token>`.

**REST** is Discord's dialect at `INSTANCE/bot/v1/...` (Velora serves it at `/chat/api/v1`): `GET /bot/discovery` (`{ api_code_version, endpoints: { api, api_public, api_client, gateway } }`), `GET /bot/v1/gateway`, and with a token `GET /gateway/bot`, `/users/@me`, `/users/@me/guilds`, `DELETE /users/@me/guilds/:gid`, `/users/:uid`, `/guilds/:gid` (+ `/roles`, `/channels`, `/members`, `/members/:uid`), `/channels/:cid` (+ `POST /typing`), `GET/POST /channels/:cid/messages`, `GET/PATCH/DELETE /channels/:cid/messages/:mid`, `PUT/DELETE /channels/:cid/messages/:mid/reactions/:emoji/@me`, `PUT/DELETE /channels/:cid/pins/:mid`. Ids are numbers (guild = community row id, channel / message / user = row ids, role = 1000000000 + row id, `@everyone` = the guild id). Message bodies take `content`, `embeds`, `message_reference`, `allowed_mentions`, multipart `payload_json` + files. A bot posts as a member: it needs Send in the channel and obeys locked / no-chat channels. Rate limit **150 requests / 10 s per bot** (`429`). Errors are `{ message, code }`.

**Gateway:** `ws(s)://INSTANCE/bot/gateway`, Discord-style: server `op 10 hello { heartbeat_interval }`; client `op 2 identify { token }` (bad token closes `4004`); `op 1` heartbeat answered with `op 11`. Dispatch (`op 0`, `t`, `s`, `d`): `READY`, `GUILD_CREATE` (whole community, also when a manager adds the bot), `GUILD_UPDATE`, `GUILD_DELETE`, `GUILD_MEMBER_ADD / REMOVE`, `MESSAGE_CREATE / UPDATE / DELETE`, `MESSAGE_REACTION_ADD / REMOVE`. A bot only receives events for channels it can see.

## 15. YouTube player (optional)

The client's "watch without YouTube" player. It needs a **yt-dlp** binary on the instance (not bundled: install it and put it on PATH, or set `youtube.ytdlp_path`). It is detected at boot and whenever the `youtube` settings change; `features.youtube` in discovery says whether it works. While it is off every route below answers **`503 { "error": "youtube_unavailable" }`**.

| route | auth | result |
|---|---|---|
| `POST /yt/:id/prepare` | session (`chat` scope) | starts fetching; `{ status: "queued"\|"downloading", progress, part }` / `{ status: "ready", src, download }` / `{ status: "error", error: "too_long"\|"not_available"\|"server_busy"\|"failed" }` |
| `GET /yt/:id/status` | session | same shapes (`{ status: "none", can_download }` when idle) |
| `POST /yt/:id/save { title }` | session + `media` scope | fetches if needed (poll again); then `{ status: "saved", id, attachment: { url, type: "video", name, size, sha256 } }`, a regular upload in `/uploads/` (subject to `allow_uploads` and the size limit) |
| `GET /yt/stream/:id?e=&s=[&dl=1]` | HMAC link | the video, `Range` supported; `403 link_expired` for a bad / expired / mismatched signature, `404 not_ready` |

`:id` must match `[A-Za-z0-9_-]{11}` (`400 bad_video`), and yt-dlp is spawned with an argument array, never through a shell. `src` / `download` are absolute URLs on the instance, signed with an HMAC (`sha256(secret, id.expires.dl)`, secret per process, 6 h validity, a stream link cannot be turned into a download). Videos are capped at 2 h / 720p / 900 MB, at most 2 downloads run at once, files are kept 24 h after the last watch, and the cache is trimmed oldest-first to `cache_max_gb`. Unlike Velora there are no account tiers: every signed-in member gets the download link.
