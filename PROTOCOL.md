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
  "features": { "signing": true, "voice": false, "uploads": true, "youtube": false, "minecraft": true, "bridges": { "discord": false, "fluxer": false, "cloudlink": true } },
  "max_upload_mb": 25,
  "managed": { "plan": "starter", "limits": { "member_cap": 30, "max_upload_mb": 10, "emojis": 50, "sounds": 10, "bots": 2, "bridges": false, "custom_voice_keys": false }, "host": "velora" } | null,
  "read_only": false,
  "community": { "sid": "s…", "name": "…", "icon_url": null, "description": "", "member_count": 3, "join_policy": "open" | "request" } | null,
  "instance_key": "<b64url raw 32-byte Ed25519 public key>", "instance_id": "ik_…"
}
```
- `registration` applies only to local mode.
- `features.signing` is false in local mode. `features.youtube` is true only when the optional yt-dlp player works (§15).
- `features.minecraft` is always true (the Bonfire Link game gateway, §18); `features.bridges` says which bridge bots the owner has configured (§16; CloudLink needs none, §17).
- `community` is the instance's one community (always shown, it's what the URL is for), or `null` while the instance is unclaimed / not set up yet.
- `name` / `description` / `icon_url` mirror the community once it exists.
- `instance_key` / `instance_id` are the instance's relay key (§12.1). Velora reads them here to check that a registering key controls the url.
- `features.voice` is true when voice works: the instance's own Cloudflare keys, or Velora's voice broker while registered and under its cap (§10).
- `managed` is non-null on a Velora-hosted instance (§19.2): its plan and limits (`null` = unlimited). `features.bridges` is `false` when the plan has no bridges. `max_upload_mb` is already capped by the plan.
- `read_only` is true while the instance refuses all writes (§19.3).

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
| `accounts_mode` | `"velora"` / `"local"` | **requires restart**; existing principals of the other kind can no longer log in. GET also returns `running_accounts_mode`, `restart_required` and `accounts_mode_env` (true when env `BONFIRE_ACCOUNTS_MODE` fixes the mode, so a saved change has no effect until it is removed) |
| `velora_url` | origin | default `https://velora.ikelene.net` |
| `registration` | `"open"` / `"closed"` | local mode |
| `max_upload_mb` | int 1–500 | instance ceiling (managed: follows the plan) |
| `max_backups` | int 1–50 | retained instance backups; default 10, oldest pruned first |
| `voice` | `{ cf_app_id, cf_app_secret, cf_turn_key_id, cf_turn_token }` | secrets are **write-only**; GET returns `{ cf_app_id, has_app_secret, cf_turn_key_id, has_turn_token }` |
| `youtube` | `{ enabled, ytdlp_path, cache_dir, cache_max_gb }` | optional player, §15. Defaults `true`, `"yt-dlp"` (on PATH), `""` (= `DATA_DIR/cache/yt`), `5` |
| `velora_registration` | `"auto"` / `"off"` | default `auto`: register with `velora_url` and use the relays (§12.11). `off`: never contact Velora (no push, payments, daily credits, voice broker, directory). Env `BONFIRE_VELORA_REGISTRATION` overrides |
| `listed` | bool | show the instance in Velora's public directory (§12.9). The **same value** as the community's `listed` (patching either side updates both) |
| `tags` | string[] | ≤ 8 directory tags, ≤ 24 chars each, lower-cased, no commas |

`GET` (and `PATCH`) also return read-only relay status: `velora: { registration, velora_url, registered, instance_id, trusted, voice: { cap_minutes, used_minutes } | null, registered_at, last_error, voice_backend: "direct" | "broker" | null, directory: { listed, hidden_by_staff, pushed_at, last_error } }`. `POST /api/v1/instance/velora/register` (admins) registers right away and returns the same object; it takes no body (a `token` field is ignored: Velora tokens never go to an instance). `GET /api/v1/instance/owner-attestation` (instance owner only) returns `{ attestation, instance_id }` for the payee flow (§12.1).

On a Velora-hosted (managed) instance `GET`/`PATCH` also return `managed` (same object as in discovery), `max_upload_mb` is capped by the plan, and `accounts_mode`, `public_url`, `velora_url` and `velora_registration` cannot be changed (`403 managed_setting`); see §19.2.

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

### 5b. Backups

Available on every instance (self-hosted, Starter and Plus). Authentication uses an **instance session**, never a Velora token. Backups are portable `bonfire-export-v1` ZIPs (section 9), saved in `DATA_DIR/backups/<id>.zip` with a SQLite index. Keep at most `max_backups` (default 10, configurable 1-50 through instance settings); the oldest are removed first. Lowering the setting through PATCH prunes immediately.

A backup is `{ id: <32 hex chars>, created_at: <ms>, size: <bytes>, by: <principal>, note: <string> }`. Notes are optional strings up to 300 characters.

| route | authorization | body / result |
|---|---|---|
| `POST /api/v1/instance/backups` | instance admin (owner always) | `{ note? }` -> `{ backup }`; `409 no_community` if not set up |
| `GET /api/v1/instance/backups` | instance admin | `{ backups: [backup...] }`, newest first |
| `GET /api/v1/instance/backups/:id/download` | instance admin | `application/zip`, attachment `<id>.zip` |
| `DELETE /api/v1/instance/backups/:id` | instance admin | `{ ok: true }` |
| `POST /api/v1/instance/backups/:id/restore` | instance owner only | no body -> `{ ok: true, sid }` |
| `POST /api/v1/instance/restore` | instance owner only | multipart `file` (export ZIP, max 500 MB) -> `{ ok: true, sid }` |

Unknown IDs return `404 backup_not_found`. Read-only mode permits list/download and rejects all four write operations with `403 read_only`. Non-admins receive 403; restore by a non-owner admin receives `403 owner_only`.

Restore validates the archive, takes an automatic safety backup with note `before restore` when a community exists, then replaces the community through the normal delete/import paths in a transaction. A failed import rolls back the database; the safety ZIP remains subject to normal retention. Imported community ownership is the instance owner. IDs are remapped, so clients must discard cached community/channel IDs. Success broadcasts `instance_restarting`, closes gateway sockets with code 4010, and returns the new `sid`; reconnect and reload discovery/server detail. The process stays running. Instance settings for relays, registration, admin accounts, and identity keys remain in place. An empty instance can also restore an uploaded ZIP (there is nothing to safety-back up).

## 6. Communities: REST (compatibility rule)

**Rule:** every endpoint below uses the same path as Velora's current `routes/chat.js`, with the `/chat` prefix replaced by `/api/v1`. It has the same request body and the **same response JSON shape** as Velora returns today. The only difference is that user ids are principal strings (§4).

A server/community object gains these fields:
- `join_policy`: `"open"` or `"request"`
- `allow_signing`: bool, true in velora mode (signing is always allowed there and never required). Older clients may still send `allow_signing` / `require_signing` in `PATCH`; they are ignored.
- `allow_uploads`: bool
- `upload_max_mb`: int; the community default edited by community settings (never the caller's role limit)
- `my_upload_max_mb`: int; the caller's effective per-file limit with roles, instance ceiling and managed plan applied; returned in personalized server objects, including `GET /api/v1/servers/:sid`, server lists and community PATCH responses; omitted from broadcasts/public views without a caller
- `upload_ceiling_mb`: int; `min(instance.max_upload_mb, managed.limits.max_upload_mb if set)`, the maximum the client can offer in the role upload-limit field
- `listed`: bool
- `instance`: the normalized origin of the instance

Core subset for v1:
- **Servers:** `GET/POST /servers`, `GET/PATCH/DELETE /servers/:sid`, `PUT /servers/:sid/layout`, `POST /servers/:sid/join`, `POST /servers/:sid/leave`, `GET /invite/:code` (public), `POST /join/:code`, `POST/DELETE /servers/:sid/icon|banner`
- **Members:** `GET /servers/:sid/members` (each member also has `joined_at`, ms), `DELETE /servers/:sid/members/:uid` (`?ban=1`), `DELETE /servers/:sid/bans/:uid`, `GET /servers/:sid/bans`
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
| Roles shop | `GET /channels/:cid/shop`, `POST/DELETE /channels/:cid/shop/:rid`, `GET /channels/:cid/shop/:rid/status` (paid roles, §6.1) |
| Starboard | `GET /channels/:cid/starboard[?before=<starred_at>]` |
| Webhooks (§13) | `GET/POST /channels/:cid/webhooks`, `PATCH/DELETE /hooks/:wid`, `POST /hooks/:wid/avatar`; execute: `/webhooks/:wid/:token` |
| Soundboard (§6.2) | `GET /sounds`, `GET/POST /servers/:sid/sounds`, `PATCH/DELETE /servers/:sid/sounds/:id` |
| Link previews (§6.3) | `GET /unfurl?url=` |
| Bots (§14) | `GET/POST /bots`, `GET /bots/by-name/:username`, `POST /bots/by-name/:username/add`, `PATCH/DELETE /bots/:id`, `POST /bots/:id/avatar`, `POST /bots/:id/token` |
| Notifications | `GET /notify`, `PUT /notify/:target` (`{ level: default|all|mentions|none, mute_minutes: 0 unmute | -1 forever | n, push }`) |
| Search | `GET /servers/:sid/search?q=` with `from:name`, `in:channel`, `has:image|video|file|link|embed|sound|audio` (voice, link, roles-shop and starboard channels are never searched) |
| Emojis | `GET /emojis/:eid/info` |
| YouTube (§15) | `POST /yt/:id/prepare`, `GET /yt/:id/status`, `POST /yt/:id/save`, `GET /yt/stream/:id` |
| Discord / Fluxer bridge (§16) | `GET/PATCH /bridge/settings`, `GET /bridge/platforms`, `GET /bridge/:platform/guilds`, `GET/PUT/PATCH/DELETE /bridge/servers/:sid`, `PUT /bridge/servers/:sid/channels/:cid` |
| CloudLink (§17) | `GET /channels/:cid/cloudlink`, `POST /channels/:cid/cloudlink/reconnect` |
| Bonfire Link / Minecraft (§18) | `/game/*` |

### 6.1 Channel types

`type` is one of `text`, `voice`, `logs`, `roles`, `welcome`, `link`, `starboard`, `game` (Bonfire Link, §18). Anything else is `text`. `config` is validated and cleaned per type (Manage channels; the response shows the cleaned value):

| type | `config` | posting |
|---|---|---|
| `text` | `{}` | needs Send (and not locked) |
| `voice` | `{ allow_call_in, user_limit 0–99 }` | no chat |
| `logs` | `{}` - webhooks post here (§13); or a CloudLink bridge `{ mode: "cloudlink", url, room, username }` (§17) | only Manage messages (and webhooks / bots with the permission); a CloudLink channel: needs Send (and not locked) |
| `welcome` | `{ allow_chat, join: [template…], leave: [template…] }`; a template contains `{user}` (and may use `{server}`, `{count}`), ≤ 20 of ≤ 200 chars, others are dropped | Manage messages, unless `allow_chat`; the instance posts a system line (`sys_kind` `join` / `leave`, with the `subject` account) here when someone joins or leaves, using the templates or a built-in default |
| `link` | `{ url }` (http/https, else `400 bad_link`) | no chat |
| `roles` | `{ items: [{ rid, price 0–1000000, desc ≤ 200 }] }` ≤ 25, roles must be below yours and not Administrator (`shop_admin_role`), needs Manage roles | no chat |
| `starboard` | `{ watch: [cid…] (none = every text/welcome/logs channel), min 1–100 (default 3) }` | no chat |
| `game` | `{ game, instance, purpose, events, address, show_players, show_server_tag }` (§18.3); not set up = managers only, `console` = Manage server only | only `purpose: "chat"` (needs Send) |

A locked channel always needs Manage messages. `can_post` in `GET /servers/:sid` reflects all of this.

**Roles shop.** `GET /channels/:cid/shop` → `{ items: [{ role, price, desc, has, owned, pending? }], balance: null, owner_free, payments: "velora" | "unavailable" | "velora_required" }` (`balance` is null: the instance has no credits; `owned` = free, you are the owner, or you bought it; `pending` = your open pay request for that role). `POST /channels/:cid/shop/:rid` (body `{ price? }`, the price the client showed: `409 price_changed` if it differs) self-assigns a free or already bought role. `DELETE` takes the role off. Both return the shop view and push `chat_member_update` + `chat_perms_changed`.

**Paid roles** go through Velora credits (§12.5): for a priced role you have not bought (and you are not the owner), `POST` creates a Velora pay request and answers `200 { ...shop view, pending: true, pay_request: { id, status: "pending", approve_url, amount, expires_at } }`. Asking again while it is open returns the same request. The client opens `approve_url` (Velora's Pay / Cancel page), then polls `GET /channels/:cid/shop/:rid/status` → `{ status: "none" | "pending" | "paid" | "declined" | "expired" | "failed", pay_request, ...shop view }` (the instance also polls Velora itself). On `paid` the instance has verified the receipt and granted the role (`chat_member_update`, `chat_perms_changed`, and to the buyer `chat_shop_update { server, channel, rid, status }`, which is also sent for `declined` / `expired`). `failed` carries `pay_request.error` (e.g. `receipt_wrong_amount`). Like Velora's own shop, a bought role is kept: take it off and put it back on for free; there are no refunds, and deleting the role deletes the purchase. Errors: `402 velora_required` (local accounts cannot pay), `402 payment_unavailable` (the instance is not registered with Velora, or `velora_registration` is `off`), and Velora's pay-request errors passed through (`403 not_subscribed`: add the instance to your Bonfire list; `429 too_many_requests`; `503 payee_unavailable`).

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
| `POST /import/velora { ticket }` | same rules as `/import` | `{ sid }`: downloads a Discord / Fluxer import prepared on Velora (§12.6, §12.11) |

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
2. The server replies `{ "type": "auth_success", "user": <user>, "instance_admin": bool, "instance_owner": bool, "voice_quota"?: { cap_minutes, used_minutes } }` (`voice_quota` only for admins, once known, §19.4), or closes with `4001` (`invalid_session`).
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
- Mentions: `chat_mention { id, server, sid, channel, cid, from, pfp, body }`, sent only to the people a message pings who are online (their `@name`, a reply to them, `@everyone`, `@here` (online members only), a role they hold, or every message if their level is `all`), minus muted / `none` settings. Everyone else goes to the server-side `notifyOffline(userIds, payload)` hook, which pushes Velora principals through Velora (§12.3, §12.11).
- Starboard: `chat_starboard { server, channel (the board), id (message), stars, added? }` when a watched message's stars change (`added: true` the moment it first lands on the board)
- Voice: `chat_voice_state` and the rtc replies
- Soundboard: the client sends `{ type: "voice_sound", sound: "<sound id>" }` while in a voice room (needs the `voice` scope); every socket in that room, the sender included, gets `{ type: "voice_sound", by: "<username>", channel: "<cid>", sound: { id, name, emoji, volume, duration, url } }`. Failures come back to the sender only as `{ type: "voice_sound_failed", reason }` with `not_in_voice`, `not_found`, `not_allowed`, `too_fast` (one sound per 1.2 s) or `insufficient_scope`.

New events:
- `chat_join_request { sid, request }` goes to members who can accept.
- `chat_join_result { sid, accepted }` goes to the requester.
- `chat_server_added { server }` is sent when you join or are accepted (or the community is created for you as its owner).
- `instance_update { settings: <public subset>, voice_quota? }`: `voice_quota: { cap_minutes (null = unlimited), used_minutes }` is sent to instance admins only, after each refresh of the voice quota (§19.4).
- `instance_restarting {}`
- `chat_shop_update { server, channel, rid, status }`: your pay request for a shop role was `paid` (role granted), `declined` or `expired` (§6.1).
- Bonfire Link: `game_status`, `game_console`, `game_linked`, `game_unlinked` (§18.4).

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

Signing is available only in velora mode and only to sessions whose `scp` contains `"sign"`. It is **optional**: every community in velora mode accepts signed messages, and no community can require them (unsigned messages are always accepted, with `verified: null`).

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

If verification fails, the instance rejects the message with `bad_signature`. Bots, webhooks and system messages never carry signatures.

**What the API returns.** Each message gains `signature: { kid, sig, ts, nonce } | null` and `verified: true | false | null`. `null` means unsigned. **Clients verify independently** against Velora keys, so they don't trust `verified`. An edit without a signature clears `signature` and `verified`. Exports keep signatures, and so does a later re-import.

---

## 9. Export format `bonfire-export-v1` (zip, built with `fflate`)

| path | contents |
|---|---|
| `manifest.json` | `{ format: "bonfire-export-v1", source: "<origin>", source_kind: "instance" \| "velora-legacy" \| "velora-import", exported_at: <ms>, community: "<sid>" }` |
| `community.json` | `{ name, description, icon, banner, settings: {join_policy, allow_uploads, upload_max_mb}, categories: [name…], channels: [ {cid, name, topic, category, position, locked, type, config, perms: [ {role: "<rid>", allow, deny} ]} ], roles: [ {rid, name, color, position, permissions, upload_max_mb, hoist, mentionable, is_default} ], emojis: [ {eid, name, animated, file} ], invites: [ {code, expires_at, max_uses} ] }` |
| `members.jsonl` | one JSON object per line: `{ user: <user object>, roles: ["<rid>"…], joined_at, owner?: true }` |
| `messages/<cid>.jsonl` | oldest first, one JSON object per line: `{ id, author: <user object> \| null, author_name?, author_avatar?, body, attachments, embeds?, reply_to, created_at, edited_at, system, sys_kind?, pinned, reactions: [ {emoji, users: [uid…]} ], signature?, bridge? }` |
| `files/<path>` | icon, banner, emojis, and locally hosted attachments, referenced as `files/…` from the JSON |

Import rules:
- The importer recreates the community with new ids and maps old ids to new ones for channels, roles, messages (including `reply_to`) and emojis.
- `allow_signing` / `require_signing` in the `settings` of older exports are ignored (signing is always optional, §8).
- The **owner of the import is whoever runs it**. The exported owner flag is kept only as a hint.
- `v:` principals keep their identity. `l:` principals from another instance become **name-only authors**: `author_name` and `author_avatar` are set and there is no account.
- On a velora-mode instance, members whose principal is `v:` are recreated as members with their roles.
- Channel `config` of the typed channels (§6.1) is carried over: link `url`, welcome templates, starboard `watch` (channel ids remapped) and shop `items` (role ids remapped), CloudLink settings of `logs` channels (re-validated, at most 3) and `game` channel settings (purpose, events, address, …; the Minecraft link itself does not travel: `instance` becomes null, so the channel needs a server picked again).

---

## 10. Voice

Voice uses the same `chat_rtc_*` protocol Velora has today (`chat_rtc_join`, `publish`, `connected`, `subscribe`, `answer`, `close`, `ice` and `leave`, plus `chat_rtc_joined`/`published`/`offer`/`ready`/`room` and `chat_voice_state`). It runs over the instance gateway, and rooms are named `bf_<cid>`.

Backend, chosen per join: (1) the instance's own Cloudflare Realtime keys (`voice` settings) when all four are set; else (2) **Velora's voice broker** (§12.7) while the instance is registered and Velora has voice set up; else `chat_rtc_join` returns `chat_error { nonce, error: "voice_unavailable" }`. Through the broker the receive session is created on the first subscribe (sessions are metered), every open session gets a heartbeat each minute, and when the instance is over its monthly cap the joiner gets `chat_error { nonce, error: "voice_cap_reached", cap_minutes, used_minutes }` (and `features.voice` turns false until Velora answers again). A participant stays on the backend they joined with.

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
- Roles accept `upload_max_mb: <integer 1-500> | null` on `POST /api/v1/servers/:sid/roles` and `PATCH /api/v1/servers/:sid/roles/:rid`. Omission on create means null; omission on PATCH leaves it unchanged. Role objects (including gateway updates and exports) return this field; older exports without it import as null. Invalid values return `400 invalid_upload_max_mb`.
- For a member, size is `min(instance.max_upload_mb, managed.limits.max_upload_mb if set, max(community.upload_max_mb, all held role upload_max_mb values))`; the implicit everyone role counts. Null role values add no override. The owner gets the instance/plan ceiling. A lower role value cannot reduce the community default. Managed instance ceilings follow the plan (Starter 10 MB, Plus 250 MB by default).
- `GET /api/v1/servers/:sid` keeps `server.upload_max_mb` as the community default, returns the caller's effective value in `server.my_upload_max_mb`, and exposes the instance/plan ceiling in `server.upload_ceiling_mb`. Use the default for community settings, the effective value for upload checks, and the ceiling for the role editor. Refresh detail after roles/settings change. Oversized streaming uploads stop buffering immediately and return `413 { error: "file_too_large", max_mb: <effective limit> }`.
- Files are served with `Cache-Control: public, max-age=31536000, immutable` and `X-Content-Type-Options: nosniff`. Non-media types are served with `Content-Disposition: attachment`.

---

## 12. Velora relays

Services an instance asks Velora for: registering, push, credit payments, daily credits, the voice broker, import bundles and the public directory. People and the public call the matching routes under `VELORA/bonfire/*`. Everything an instance calls is **signed with the instance's Ed25519 key** (§12.2). Velora never fetches an instance-supplied URL. Dev: `http` instance urls need `BONFIRE_DEV=1` on Velora (as in §1); public urls stored for the directory must be `https`.

### 12.1 Registration
The instance has an Ed25519 key (`DATA_DIR/keys/instance.key`). Its **`instance_id`** is `ik_` + first 16 hex of `sha256(raw 32-byte public key)`. `pubkey` is the b64url of the raw 32 bytes (same encoding as the signing key, §2.3). `url` is the instance's `public_url` (normalized as in §1).

1. `POST VELORA/bonfire/instances/challenge` `{ pubkey, url }` -> `{ nonce, expires_in: 300 }` (single use).
2. `POST VELORA/bonfire/instances/register` `{ pubkey, url, name, accounts_mode: "velora"|"local", nonce, sig }` where `sig` = b64url Ed25519 over the UTF-8 string `bonfire-register-v1|<nonce>|<normalized url>` -> `{ instance_id, trusted, voice: { cap_minutes, used_minutes } }`.

- Upserts by key hash, so re-registering updates `url`, `name` and `accounts_mode` (call it on every start). `cap_minutes` is `null` when unlimited (trusted).
- Registration never reads an `Authorization` header and never changes the instance's owner. A Velora token is never sent to an instance.
- Errors: `invalid_pubkey`, `invalid_url`, `invalid_nonce`, `bad_signature` (401), `invalid_accounts_mode`, `invalid_name`, `url_taken` (409, another key owns that url), `instance_banned` (403). Rate limited per IP (429 `rate_limited`).
- `name` is stored with control characters and `<>` stripped, max 80 characters.
- **Url proof:** before binding a url that is not already bound to this key, Velora fetches `<url>/.well-known/bonfire` and requires its `instance_key` (§3) to equal `pubkey`; otherwise `403 { error: "url_unverified", reason }` (`reason`: `key_mismatch`, `no_instance_key`, `private_address`, `bad_status`, `timeout`, `too_large`, `dns_failed`, `fetch_failed`, …). The fetch is SSRF-guarded: http(s) only, no credentials, refused when the host resolves to any private, loopback, link-local, CGNAT, metadata, multicast or reserved address (IPv4 and IPv6, incl. IPv4-mapped, NAT64, 6to4 and Teredo forms; the connection is pinned to the checked address), redirects (max 3) re-checked, 5 s total, 64 KB max. With `BONFIRE_DEV=1` localhost / private targets are allowed (dev stack), cloud metadata addresses never are. So the instance must be reachable at `public_url` when it registers. An admin can still remove a registration.
- `trusted` is set only by Velora staff (for `chat.ikelene.net` and hosted instances). It unlocks §12.4 and unlimited voice.
- `instance-token` (§2.2) refuses audiences that are banned (403 `instance_banned`).

**Payee (owner attestation).** The instance **owner** receives pay-request payments (§12.5) once Velora knows their account. The owner proves it with a short-lived proof signed by the instance, and presents it to Velora themselves:
1. `GET INSTANCE/api/v1/instance/owner-attestation` (instance owner session only) -> `{ attestation, instance_id }`. Errors: 403 `owner_only`, 400 `owner_not_velora` (the owner is a local account), 409 `not_registered`.
2. `POST VELORA/bonfire/instances/payout { attestation }` with the owner's own Velora bearer token (scope `CHAT`; Bonfire's token, called by the client) -> `{ ok: true, instance_id }`. Sets the instance's `owner_user_id` to the caller.
- `attestation` is a compact JWS signed with the instance key: header `{ "alg": "EdDSA", "typ": "bonfire-owner+jwt" }`, claims `{ iss: <instance_id>, url: <public_url, normalized>, sub: <owner Velora id, string>, iat, exp: iat + 300, jti: <random> }` (seconds).
- Velora finds the instance by `iss`, verifies the signature with that row's stored `pubkey`, requires `typ`, `exp` in the future but at most 10 min ahead, `url` equal to the row's url, `sub` equal to the caller's Velora id, and a `jti` not seen before. Errors: 400 `invalid_attestation`, 404 `unknown_instance`, 403 `not_owner` (`sub` is another account), 403 `instance_banned`.


**Payout card:** `GET VELORA/bonfire/instances/payout?url=<instance origin>` (bearer + `CHAT`) returns `{ linked: bool, payee: { id: <string>, username, pfp } | null, linked_at: <ms> | null, you: bool }`. Normalize the URL as in section 1. Only the registered owner/current payee can read it (`403 forbidden` otherwise); unknown instance -> `404 unknown_instance`, bad URL -> `400 invalid_instance`. The existing registry uses `owner_user_id` for both the owner and payout target, so those are the same account. `you` compares the payee with the caller. `linked_at` records the last successful owner attestation; pre-existing/automatically registered ownership may return null. A missing payee account returns `linked: false`, `payee: null`, `you: false`.

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


Clients display the payout target using `GET /bonfire/instances/payout?url=` (section 12.1). `POST /bonfire/instances/payout { attestation }` still links payouts through the signed owner attestation and now records `linked_at`. No DELETE/unlink endpoint is provided; the existing payout fallback behavior is unchanged.

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

### 12.11 Instance behaviour (bonfire-server)
- **Owner attestation.** `GET /api/v1/instance/owner-attestation` is owner-only, needs the owner principal to be a Velora user and the instance to be registered (§12.1). The instance never receives, forwards or stores a Velora token.
- **Key + registration.** The key is generated on first boot (`DATA_DIR/keys/instance.key`, PKCS#8 PEM, mode 0600; keep it with backups, it is the instance's identity on Velora). Once the HTTP server listens, the instance registers (§12.1) in both accounts modes (local-mode instances use Velora only for these opt-in services); it never blocks startup, retries with backoff (5 s … 30 min), re-registers when `velora_url`, `public_url`, `name`, `accounts_mode` or `velora_registration` change and every 12 h, and again after a `401 unknown_instance`. `instance_id`, `trusted` and the voice cap are kept in the database (`meta`). `velora_registration: "off"` stops every Velora call.
- **Push** (§12.3): only for Velora principals (`v:`) that `notifyOffline` reports (pinged, not connected to this instance, push not muted). `kind` is `reply` for a reply to them, else `mention`; `title` "`<from>` mentioned you" / "replied to you"; `preview` is the message (≤ 300); `url` is `INSTANCE/#/s/<sid>/<cid>` (on the instance's own origin as Velora requires; the fragment is the client route, i.e. `VELORA/chat#/i/<instance>/s/<sid>/<cid>`). Per user and channel at most one push per 30 s: later pings in the window become one summary ("3 new mentions in #general"), dropped if the person connected meanwhile.
- **Daily credits** (§12.4): the first message (people only: not system, webhook or bridged) of the UTC day by a Velora principal calls `relay/daily` when the instance is `trusted`; a `claimed` answer sends that person `chat_ephemeral { server, channel, kind: "daily", amount, body: "You claimed your daily chat credits (+5 credits)." }` (unless their `daily_notice` setting is false). `403 not_trusted` marks the instance untrusted until the next registration says otherwise.
- **Paid roles** (§6.1, §12.5): `ref` is `role:<rid>:v<velora id>:<attempt>:<random>`, unique per person, role and attempt and reused on retries. A background poller asks Velora every few seconds while requests are open. Receipts are checked offline against the JWKS (same cache as login, §4): `alg` EdDSA, `typ` exactly `bonfire-receipt+jwt`, signature, `iss` = `velora_url`, `aud` = `public_url`, `sub` = the buyer's Velora id, `amount`, `ref`, `rcp` = the request id, not expired, and `rcp` never used before. A bad receipt fails the attempt and grants nothing. Login refuses any JWT whose `typ` is not `JWT`.
- **Voice broker** (§10, §12.7): see §10.
- **Directory** (§12.9): while `listed` is on, the instance PUTs `{ listed: true, name, description, icon_url (absolute), member_count, invite_url, tags }`, where `invite_url` is the community's permanent invite opened in Bonfire on the web (`VELORA/chat#/i/<instance>/invite/<code>`). It re-pushes (debounced) when any of that changes and every 6 h; turning `listed` off sends `{ listed: false }`. A link Velora refuses (it stores only `https`) is dropped from the listing instead of failing it.
- **Import** (§12.6): `POST /api/v1/import/velora { ticket }` (instance admins, only while no community exists) downloads `relay/import/bundle?ticket=` and runs the zip importer (§9). Velora's errors come back with the same codes plus a `message`: `404 ticket_invalid`, `403 ticket_wrong_instance`, `409 not_ready` (`retry: true`), `410 ticket_expired` / `import_failed`; `503 velora_not_registered` / `velora_off` when the instance cannot reach the relays.

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

## 16. Bridges: Discord and Fluxer

The instance owner connects **their own bot** for each platform (Discord, Fluxer; Fluxer's API is Discord's). The instance runs a minimal gateway client per configured token (no discord.js): `hello` → `identify` (Discord: intents `GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT` = 33281; Fluxer: no intents) → heartbeats with ack tracking (a missed ack reconnects), `op 7` / `op 9` / dropped connections reconnect with backoff and **resume** (`op 6`) while the session is valid; close codes 4004 and 4010–4014 stop the client (`state: "error"`). It handles `MESSAGE_CREATE`, `MESSAGE_UPDATE`, `MESSAGE_DELETE`, `MESSAGE_DELETE_BULK`. REST is plain `fetch` with `Authorization: Bot <token>` and waits out `429` (`retry_after`, ≤ 15 s, 5 tries). Fluxer's endpoints come from `https://fluxer.app/.well-known/fluxer` (`endpoints.api_public | api | api_client`, `endpoints.gateway`); Discord's gateway URL from `GET /gateway/bot`.

**Instance settings** (instance admins; stored in the database table `bridge_settings`, not in `config.json`):

| route | result |
|---|---|
| `GET /api/v1/bridge/settings` | `{ bridges: { discord: B, fluxer: B } }`, `B = { configured, token: "********WXYZ" \| null, source: "settings" \| "env" \| null, state: "off" \| "connecting" \| "ready" \| "waiting" \| "error" \| "stopped", error, bot: { id, username } \| null }`. The token is **write-only**: only its last 4 characters are shown |
| `PATCH /api/v1/bridge/settings` `{ discord?: { token }, fluxer?: { token } }` | a non-empty token is checked with `GET /users/@me` first (`400 invalid_token { platform }`, `502 platform_unreachable`), saved, and the gateway (re)connects; `""` keeps the stored token, `null` removes it. Same response as GET |

Env fallbacks: `BONFIRE_DISCORD_TOKEN`, `BONFIRE_FLUXER_TOKEN` (used when the setting is empty). Discovery shows `features.bridges = { discord, fluxer, cloudlink: true }` (configured or not).

**Community routes** (same paths and shapes as Velora's `/chat/bridge/*`; all need **Manage server** in the community; there is no linked-account check, since it is the owner's bot):

| route | result |
|---|---|
| `GET /bridge/platforms` | `{ platforms: [ { id, name, ready, bot, invite, linked: true } ] }` (`invite` = the bot's OAuth add-to-server link) |
| `GET /bridge/:platform/guilds` | `{ guilds: [ { id, name, icon } ] }` = the bot's servers (`/users/@me/guilds`) |
| `GET /bridge/servers/:sid` | `{ bridges: [ { platform, platform_name, guild_id, guild_name, enabled, problem, links: [ { cid, ext_channel_id, ext_name, hook } ], ext_channels: [ { id, name, category } ] } ], bridge, links, ext_channels }` (`bridge` / `links` / `ext_channels` = the first bridge, for old clients). `problem`: `bot_not_in_server`, `unreachable`, `bridge_not_set_up` |
| `PUT /bridge/servers/:sid { platform, guild_id, automap? }` | links the community to one server per platform (`already_bridged`, `bot_not_in_server` 404, `bridge_not_set_up` 503). `automap` (default true) links text channels whose names match after lower-casing and dropping everything but `a-z0-9` (`general` = `General`), and creates their webhooks right away |
| `PATCH /bridge/servers/:sid { platform, enabled }` | pause / resume without losing the links |
| `DELETE /bridge/servers/:sid { platform }` (or `?platform=`) | unlinks; the bridge webhooks over there are deleted |
| `PUT /bridge/servers/:sid/channels/:cid { platform, ext_channel_id \| null }` | link one text channel to one text / announcement channel over there (`text_channels_only`, `already_linked`, `channel_not_found`, `bot_needs_webhooks`, `bridge_failed`); `null` unlinks it |

A linked channel's view (`GET /servers/:sid`, `chat_channels_update`) carries `bridges: [ { platform, name } ]` and `bridged` (the first one).

**There → here.** A message in a linked channel is posted with `postBridged` as the person: `author = { name_only: true, webhook: true, bridge: "discord" | "fluxer", username: nick | global name | username, pfp }`. The avatar is downloaded from the platform CDN and re-hosted at `/uploads/bridge/avatars/…`; up to 4 attachments (and 2 stickers) are downloaded **only from the platform's CDN hosts** and stored as normal uploads (capped at min(25 MB, community `upload_max_mb`, instance `max_upload_mb`), and only when the community allows uploads); others become links. Text conversion: user mentions → `@\u200bname`, role mentions → `@\u200brole name`, channel mentions → `#name` (the linked local channel's name when there is one), custom emojis → a local emoji with the same name or `:name:`, `@everyone` / `@here` → `@\u200beveryone`, and a typed `<@&` → `<\u200b@&`: **nothing from a bridge pings anyone**. A reply to a bridged message becomes a real reply, other replies a quote line. Rich embeds are cleaned like webhook embeds. Message types 0, 19, 20 only.

**Here → there.** `messages.onPost` sends every message posted in a linked channel (people, bots, and messages bridged from the *other* platform) through a webhook named **"Bonfire bridge"** in the linked channel, created on first use and re-created when executing it answers 404 / 401. Payload: `{ content, username, avatar_url, allowed_mentions: { parse: [] }, embeds }` — `username` is the author's name with `discord` / `clyde` removed (Discord refuses those; empty → `Bonfire`), `avatar_url` the author's picture as an absolute instance URL (else the instance icon), role tokens become names, custom emojis are matched by name, attachments are appended as URLs, replies become a quote line with a jump link, 2000 characters at most. System lines and instance webhook posts are not sent. Webhook ids and tokens stay on the server (`bridge_channels`); they are never in an API response.

**Loop prevention.** Gateway messages from our own webhooks, and message ids we just sent (2 minutes), are ignored; a bridged message is never sent back to the platform it came from.

**Edits and deletes** go both ways through the id map `bridge_msgs (message_id, platform, ext_message_id, ext_channel_id, outbound, created_at)`: an edit here PATCHes the webhook message; a delete here deletes the webhook message, or (for a message that came from there) deletes it with the bot (needs Manage messages over there). An update there edits the bridged copy here (an update with the same text, e.g. a link preview being added, is not an edit; one without `content` is ignored); a delete / bulk delete there deletes it here (`chat_message_update` / `chat_message_delete`). Map rows older than **60 days** are pruned (every 6 hours).

Extension points used (also available to other modules): `messages.onPost`, `messages.onEdit(fn(msg, ctx))`, `messages.onDelete(fn({ id, ch, c }))`, `messages.editBridged(id, body)`, `messages.deleteBridged(id)`, `messages.postBridged(channel, { platform, name, avatar, body, attachments, embeds, replyTo, from, sysKind })`, `communities.onChannelsChanged(fn(c))`.

Not ported from Velora: importing a Discord / Fluxer server through the bot (`/bridge/:platform/guilds/:gid[/import]`) — use Velora's import bundles (§12.6).

## 17. CloudLink bridge

A `logs` channel can join a **CloudLink 4** chat instead of being a webhook channel: `config = { mode: "cloudlink", url, room, username }` (Manage channels).

- `url`: `ws:` / `wss:` only, no credentials, ports 80 / 443 only (`cl_bad_url`, `cl_bad_port`); empty = `wss://ikelene.net/cl/` (the official server). Refused (`cl_private_address`): `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.lan`, `*.home.arpa`, numeric host spellings, and any private / loopback / link-local / metadata / reserved address (the same rules as link previews, §6.3, IPv4 and IPv6). The host is resolved again on **every connect** with a lookup that refuses the connection when *any* address is private, so DNS rebinding cannot reach the LAN. `BONFIRE_DEV=1` lifts the address and port rules (development only).
- `room` ≤ 60 chars (empty = the main chat), `username` ≤ 40 (no `:`). With a room and no username the bridge uses `Bonfire`.
- At most **3** CloudLink channels per community (`too_many_cloudlink_bridges`). The view adds `official: true` for the official URL.
- Posting: unlike plain logs channels, a CloudLink channel is a chat — members with Send post (unless it is locked, then Manage messages).

The instance holds one socket per channel: `{"cmd":"handshake"}`, then `setid` (username) and `link` (room) after each `statuscode`; ready after the last step (or 8 s). It pings every 30 s and reconnects with backoff (5 s doubling to 5 min, 10 min after an address refusal).

- **CloudLink → here**: `gmsg` packets for our room whose `val` is `"Name: text"` are posted with `postBridged` as `{ bridge: "cloudlink", username: Name }`; prefixes `[Discord] `, `Fluxer | `, `Bonfire | ` set `author.bridge_from` (`Discord`, `Fluxer`, `Bonfire`). Control characters are removed, every `@` gets a zero-width space (nothing pings), 2000 characters max, 8 per 10 s and 40 per minute per channel (beyond that a system line says messages were skipped, at most once a minute). The `gmsg` a server replays before we are ready is skipped.
- **Here → CloudLink**: messages from people (not system / webhook / bridged) go out as `{"cmd":"gmsg","val":"Bonfire | <username>: <text>"}` (+ `rooms` when set): one line, role tokens as names, custom emojis as `:name:`, attachment URLs appended, `(replying to X)`, 1000 characters, 15 per 10 s. The server echoes `gmsg` back to its sender; each value we sent is skipped **once** within 20 s (echo suppression).
- **`!online`** typed in the channel is answered (as `CloudLink`) from the room's `ulist` and not forwarded.

Routes (Manage channels, CloudLink channels only, else `400 not_a_cloudlink_bridge`): `GET /channels/:cid/cloudlink` and `POST /channels/:cid/cloudlink/reconnect` → `{ status: { mode, url, room, username, official, state: "connecting" | "handshaking" | "connected" | "waiting" | "off" | "stopped", error, since, retry_at, online, users: [name…], last_in, last_out, skipped } }` (`off` + `error: "over_limit"` for a 4th channel).

## 18. Bonfire Link (Minecraft)

The `game` channel type links a Minecraft server ("Bonfire Link" plugin / mod) to the community. The plugin keeps **one outbound WebSocket** per root (a Velocity proxy, or a standalone Paper / Spigot / Fabric / Forge server) to the instance — no open ports needed.

### 18.1 Connecting: `bonfire server <url>`
1. The server owner runs `bonfire server https://chat.example.com` in the server console. The plugin stores the URL and connects to `wss://chat.example.com/game-gateway?v=1` (`http://` → `ws://`).
2. Once identified, an unlinked server shows up in the instance's **Connected game servers** list (`GET /api/v1/game/connected`, Manage server) — with its MOTD, icon, version, player count and **pairing tag** (printed in its console on startup, so the admin can tell servers apart).
3. A community admin creates a game channel (it starts "not set up", visible only to managers) and **picks the server from the list** (`POST /api/v1/game/connected/:iid/link { cid }`). The channel gets the server; the admin picks the purpose (info / console / chat).
4. Alternative (Velora's flow, kept): a claim code. `POST /api/v1/game/claims { sid, cid? }` → `{ code: "XXXX-XXXX", command: "bonfire link XXXX-XXXX", expires_at }` (10 minutes, 10 per hour per user); running the command in the console links the server whose console ran it.

### 18.2 Gateway frames
Every frame is a JSON text frame `{ "op": "<name>", "d": { … }, "id"?: <n> }`, at most 64 KB (bigger closes with 1009; binary closes 4001).

| direction | op | d |
|---|---|---|
| server → game | `hello` | `{ v: 1, nonce, heartbeat_ms: 30000 }` |
| game → server | `identify` (within 15 s) | `{ v: 1, key: <b64 SPKI DER Ed25519, 44 bytes>, sig: <b64 Ed25519 over "bonfire-gw-v1|<nonce>|<iid>">, iid, platform: paper\|spigot\|fabric\|velocity\|forge, software, mc_version, mod_version, listing: public\|private, motd: [segment], icon_sha256?, max_players, online_mode, public_address, features: { chat, events, console, console_exec } }` |
| server → game | `ready` | `{ iid, pairing_tag, linked: { server_name, sid, linked_by, linked_at } \| null, icon_needed, relay: { chat, events }, console_stream, limits: { frames_per_s: 30, chat_per_10s: 20 } }` |
| game → server | `heartbeat` `{ seq }` | answered with `heartbeat_ack { seq }` |
| game → server | `status` | `{ online, version, motd, players: { online, max, list: [ { uuid, name, display?, server? } ≤ 100 ] }, tps, uptime_s, backends?: [ { name, online, version, motd, players } ] }` |
| game → server | `icon` | `{ png: <b64> }` (PNG ≤ 48 KB, ≤ 1024 px) when `ready.icon_needed` |
| game → server | `chat` | `{ uuid, name, display, text ≤ 512, server?, bedrock? }` (linked only; 20 per 10 s, beyond that one "skipped" line a minute) |
| game → server | `event` | `{ kind: join\|leave\|death\|advancement\|switch\|server_start\|server_stop\|backend_up\|backend_down, uuid, name, display, text?, advancement?: { id, title, frame }, from?, server? }` |
| game → server | `console.log` | `{ lines: [ { t, level, logger, msg } ] }` (10 frames / s, 40 lines / s kept, a ring of 1000 lines per server) |
| game → server | `console.command` | `{ t, source: console\|rcon, by, command }` (typed on the server; audited as `[CONSOLE] …` / `[RCON] …`, status `local`) |
| server → game | `console.exec` | `{ req, command, by }`; answered with `console.result { req, ok, output: [line ≤ 100], truncated?, error? }` within 10 s |
| server → game | `chat` | `{ id, channel, author: { username, color, bot, webhook, bridge? }, segments: [segment ≤ 400 chars], reply: { author, text } \| null }` (synced-chat channels; never for messages from Minecraft) |
| server → game | `config` | `{ relay: { chat, events }, console_stream }` whenever what the channels need changes |
| game → server | `link` `{ code }` (with `id`) | answered `link_result { ok, server_name? , error?: invalid_code\|expired\|not_allowed\|already_linked\|too_many_instances\|rate_limited }` (5 per 10 min) |
| server → game | `linked` | `{ server_name, sid, linked_by }` (after a code or an admin's pick) |
| game → server | `unlink` | `bonfire unlink confirm` in the console |
| server → game | `unlinked` | `{ by: bonfire\|console, username }` |
| server → game | `error` | `{ code: rate_limited\|not_linked\|bad_op, message, fatal: false }` |

A **segment** is `{ text, color?: "#rrggbb", b?, i?, u?, s?, code?, link?: https URL, hover? }`. MOTDs are cleaned to 2 lines / 120 characters, no links.

**Identity (trust on first use).** `iid = "g" + first 16 hex of sha256(SPKI DER)`; pairing tag = the top 30 bits of sha256 bytes 8–11 as 6 Crockford characters shown `XXX-XXX`. The first identify with a key creates the identity; later ones must sign with the same key (the iid is derived from it). One session per iid: a newer one closes the older with 4006.

**Limits.** 10 open sockets per address; a token bucket of 30 frames / s (burst 60): excess frames are dropped (one `error rate_limited` per 5 s) and **10 s** of sustained excess closes the socket (4005). New identities: **5 per address per day**, 200 per hour on the instance (4008). Addresses are only kept as salted hashes (`BONFIRE_TRUST_PROXY=1` takes `X-Forwarded-For`).

**Close codes:** 4000 server error, 4001 malformed / identify first / binary, 4002 identify timeout, 4003 bad key / signature, 4004 banned, 4005 rate limited, 4006 replaced by a newer session, 4007 unsupported protocol version, 4008 too many connections / new servers from this address, 1001 instance shutting down.

The connected list only shows sessions that are identified, unlinked, not banned, sent a heartbeat or status in the last 3 minutes and have been up for 10 s; `listing: "private"` servers only show for their pairing tag; the unfiltered list shows at most 20 per address. A server is marked offline 60 s after its socket closes (at once after `server_stop`).

### 18.3 Game channels
`config = { game: "minecraft", instance: iid | null, purpose: "info" | "console" | "chat" | null, events: { join, leave, death, advancement, switch, server } (default all true), address ≤ 120, show_players, show_server_tag }` (Manage channels; `instance` must be linked to this community, `instance_not_linked`; `purpose: "console"` needs Manage server; `bad_purpose`, `bad_game`). The view adds `setup` (instance and purpose set), `instance_name`, `platform`, and `address` falls back to the server's `public_address`.

- **Visibility**: not set up → only Manage channels / Manage server / Administrator; `console` → **Manage server only** (even over Manage channels and channel permissions); otherwise the normal rules.
- **Posting**: only `chat` channels take messages (Send, like a text channel). Their messages go to the game (`chat` frame); the game's `chat` / `event` frames are posted with `postBridged` as `{ bridge: "minecraft", username: display name, pfp: https://mc-heads.net/avatar/<uuid or name>/64, bridge_from: the Velocity backend (when show_server_tag) }`; events carry `sys_kind` `mc_join`, `mc_leave`, `mc_death`, `mc_adv`, `mc_switch`, `mc_start`, `mc_stop` and respect the channel's `events` switches. Nothing from the game pings (`@` gets a zero-width space). Unlinking posts a system line (`mc_unlink`).
- A community links at most 10 servers (`too_many_instances`).

### 18.4 REST (`/api/v1/game/*`, same shapes as Velora's `/chat/game/*`; `sid` may be omitted where it is a query / body field, the instance has one community)

| route | who | result |
|---|---|---|
| `GET /game/downloads` | public | `{ version: null, modrinth_url: "", files: {} }` (the instance doesn't host plugin builds) |
| `GET /game/connected?sid=&tag=&q=&page=` (alias `/game/unclaimed`) | Manage server, 30 / min | `{ instances: [ { iid, platform, mc_version, motd, icon, players: { online, max }, pairing_tag, connected_at } ], total, page, pages, tag_match }` (20 per page) |
| `POST /game/connected/:iid/link { sid?, cid? }` | Manage server | links a connected, unlinked server (`not_connected` 404, `already_linked` 409, `too_many_instances`); `cid` = a game channel without a server that gets it → `{ instance }` |
| `POST /game/claims { sid?, cid?, hint? }` | Manage server | `{ code, command, expires_at }` |
| `GET /game/claims/:code` | the creator | `{ state: "pending", expires_at }` / `{ state: "linked", instance, hint }` / `{ state: "expired" }` (`claim_not_found` 404) |
| `GET /game/servers/:sid/instances` | Manage channels | `{ instances: [ instance ] }` |
| `DELETE /game/servers/:sid/instances/:iid` | Manage server | unlink → `{ ok: true }` |
| `GET /game/channels/:cid/status` | can view the channel | `{ instance, status, online, last_seen, connected, features }` (info channels with `show_players: false` drop the player list) |
| `GET /game/channels/:cid/console?before=<seq>` | can view (console = Manage server) | `{ lines: [ { seq, t, kind: "log", level, logger, msg } \| { seq, t, kind: "command", source: "bonfire"\|"console"\|"rcon", by, command, status? } ], has_more }` (200 per page) |
| `POST /game/channels/:cid/console { command }` | Manage server, 10 per 10 s | `{ ok: true, output, truncated }` / `{ ok: false, error: offline\|timeout\|console_disabled\|…, output? }`; every command is in the audit log |
| `GET /game/servers/:sid/audit?before=<id>` | Manage server | `{ entries: [ { id, kind: link\|unlink\|command, command, status: sent\|ok\|error\|timeout\|denied\|local, output_preview, user: { id, username, pfp } \| null, instance, instance_name, created_at } ], has_more }` (50 per page) |

An **instance** object is `{ iid, platform, software, mc_version, mod_version, name, motd, icon, public_address, online, last_seen, linked_by, linked_at, pairing_tag, backends?, channels?: [ { cid, name, purpose } ] }`.

**Gateway events** (instance gateway, §7): `game_status { server, channel, instance, status, online, last_seen }` (per game channel, debounced 2 s; online / offline at once), `game_console { server, channel, instance, lines }` (console channels), `game_linked { server, instance, claim?, hint? }`, `game_unlinked { server, instance }`. Channel events only reach members who can view that channel.

**Retention**: unlinked identities not seen for **30 days** (and not connected) are deleted hourly, with icons nobody uses; audit entries are kept a year. Discovery shows `features.minecraft: true`.

**What the plugin needs (vs. the Velora version):** a `bonfire server <url>` console command that stores the instance URL and connects to `<ws(s) of url>/game-gateway?v=1` instead of the hard-coded `wss://velora.ikelene.net/chat/game-gateway`; everything else (frames, identity, claim codes, `bonfire link` / `bonfire unlink confirm`) is unchanged. It should print the pairing tag and the instance it is connected to, and show "waiting for an admin to pick this server" while unlinked.

---

## 19. Velora-hosted instances

Velora can run a Bonfire instance for someone: a `bonfire-server` container behind `https://<slug>.bonfire.ikelene.net`, started by **bonfire-hostd** (`bonfire-hostd/`, the Docker host agent) when the owner creates a server from Bonfire. The instance is an ordinary instance (Velora accounts, registered with Velora, one community) that was started in **managed mode**. Everything on this page is optional for self-hosters: without `BONFIRE_MANAGED=1` and `BONFIRE_READ_ONLY=1` nothing changes.

### 19.1 Plans

| | `starter` | `plus` |
|---|---|---|
| who | anyone, free, 1 per account | bought in prepaid weeks |
| members | 30 | unlimited |
| voice (participant-minutes / calendar month, per instance) | 3000 | 30000 |
| upload size | 10 MB | 250 MB |
| emojis / soundboard sounds / bots | 50 / 10 / 2 | unlimited |
| Discord / Fluxer / CloudLink bridges | no | yes |
| own Cloudflare voice keys | no (always Velora's broker) | yes |

`plus` costs what Velora Pro costs with credits **per week** (`CREDIT_TIER_WEEK_COST.pro`, 50 credits). It never renews by itself (§19.8). All numbers are env-overridable on Velora (`BONFIRE_PLAN_<PLAN>_<FIELD>`, e.g. `BONFIRE_PLAN_PLUS_PRICE_CREDITS`) and editable by staff. Voice caps: a hosted instance gets its plan's number, a self-hosted untrusted one the starter number, a trusted one none, and the staff `voice_cap_override` always wins.

`GET VELORA/bonfire/hosting/plans` (public) -> `{ plans: [ { id, name, price_credits, period: "week" | null, limits: { member_cap, voice_minutes, max_upload_mb, emojis, sounds, bots, bridges, custom_voice_keys } } ], available, domain, url_template, starter_limit_per_account }`. `null` = unlimited; `period` is `null` for the free plan.

### 19.2 Managed mode (`BONFIRE_MANAGED=1`)

The host sets `BONFIRE_MANAGED=1`, `BONFIRE_PLAN` and `BONFIRE_LIMITS` (JSON of `member_cap`, `max_upload_mb`, `emojis`, `sounds`, `bots`, `bridges`, `custom_voice_keys`; a missing key falls back to the plan's number, `null` = unlimited), plus `BONFIRE_OWNER=v:<id>`, `BONFIRE_ACCOUNTS_MODE=velora`, `BONFIRE_PUBLIC_URL` and `BONFIRE_VELORA_URL`. The instance then enforces:

- **Member cap.** Joining (`POST /servers/:sid/join`, `POST /join/:code`, a join request, accepting one) past `member_cap` -> `403 { error: "member_cap_reached", cap }`. The community owner and instance admins are never blocked; bots are not counted. `GET /servers/:sid` (and every server object) has `member_cap` (`null` when none).
- **Uploads.** `max_upload_mb` and the community's `upload_max_mb` are capped at the plan's number (a larger value is accepted and reported as the cap); a file over it is `413 file_too_large`.
- **Counts.** Creating an emoji / soundboard sound / bot past its limit -> `403 { error: "plan_limit", what: "emojis" | "sounds" | "bots", limit }`. The matching list responses report the plan's `max`.
- **Bridges** off: every `/api/v1/bridge/*` route and CloudLink channel settings answer `403 { error: "plan_limit", what: "bridges", limit: false }`, `features.bridges` is `false`, and no bridge connects.
- **Custom voice keys** off: a `PATCH /api/v1/instance/settings` that sets any non-empty `voice` value -> `403 { error: "plan_limit", what: "custom_voice_keys", limit: false }` (clearing is fine); saved keys are ignored, voice always goes through Velora's broker (§12.7).
- **Locked settings.** `accounts_mode` (always `velora`), `public_url`, `velora_url`, `velora_registration` (always `auto`): a PATCH that changes one -> `403 { error: "managed_setting", setting }`. Sending the current value is accepted, so an admin form can send everything back. Restart stays allowed.

`GET /.well-known/bonfire` and `GET /api/v1/instance/settings` carry `"managed": { "plan": "starter", "limits": { … }, "host": "velora" }` (`null` on a normal instance).

### 19.3 Read-only mode (`BONFIRE_READ_ONLY=1`)

The host switches it on when a hosted server's paid time is over (§19.8). Every write is refused with `403 { error: "read_only" }`: posting (also through the gateway, bots, webhooks, bridges and Bonfire Link), editing, reactions, joins, uploads, settings, channels, roles, invites, emojis, bots, webhooks, and joining a voice room. Still allowed: signing in (`/api/v1/auth/*`) and every `GET` (including the owner's `GET /servers/:sid/export`). `/.well-known/bonfire` has `"read_only": true` and server objects have `read_only: true`. Clients should show a banner and hide write controls.

### 19.4 Voice quota for admins

`GET /api/v1/instance/settings` -> `velora.voice: { cap_minutes, used_minutes }` (`cap_minutes: null` = unlimited). While registered, the instance refreshes it from Velora (`GET /bonfire/relay/rtc/usage`) at least every **10 minutes** (and on registration) and whenever a voice call reports it. Instance admins get the numbers on the gateway: `auth_success` carries `voice_quota: { cap_minutes, used_minutes }` when known, and after every change an `instance_update { settings, voice_quota }` frame is sent to **admins only**. A client warns admins at >= 80 % (`used_minutes / cap_minutes`) and says voice stops at 100 % (`voice_cap_reached`, §12.7).

### 19.5 Velora hosting API (`VELORA/bonfire/hosting/*`)

Bearer token. Spending needs the `CURRENCY_PAY` scope (like Pro's buy route); the rest `CHAT`. Everything except `plans` answers `503 hosting_unavailable` when hostd is not configured (`BONFIRE_HOSTD_URL`, `BONFIRE_HOSTD_SECRET`, `BONFIRE_HOSTING_DOMAIN`). A hosted **server object**:

```json
{ "slug": "camp", "url": "https://camp.bonfire.ikelene.net", "name": "Camp", "plan": "starter" | "plus", "status": "provisioning" | "running" | "stopped" | "suspended" | "deleted" | "error",
  "billing": "active" | "overdue" | "read_only" | "archived", "paid_until": 1760000000000 | null, "read_only_at": <ms> | null, "archive_at": <ms> | null,
  "created_at": <ms>, "last_error": null, "price_credits": 50, "period": "week", "voice": { "cap_minutes": 3000, "used_minutes": 120 } }
```

| route | what |
|---|---|
| `GET /hosting/slug/:slug` | `{ available, reason? }`; `reason` is `invalid`, `reserved` or `taken`. A name you removed stays yours for 30 days: `{ available: true, reserved_for_you: true }` |
| `POST /hosting/servers { slug, name, plan, weeks?, restore_backup? }` | provisions; `{ server, url }`. `plus`: `weeks` 1-52 (default 1) is charged up front (`400 insufficient_balance { cost, balance }`). One free Starter per account (`403 starter_limit_reached`). Waits up to ~60 s for `GET <url>/.well-known/bonfire`; if the container is slower the server stays `provisioning` and flips to `running` when it answers. The url is added to your instance list. Velora holds **no session** on the instance: the client signs in there and calls `POST /api/v1/servers { name }` itself. Errors: `invalid_slug`, `slug_reserved`, `slug_taken` 409, `invalid_plan`, `invalid_weeks`, `backup_not_found` 404, `hosting_failed` 502 (nothing is charged or kept) |
| `GET /hosting/servers` | `{ servers: [...] }` |
| `GET /hosting/servers/by-url?url=<origin>` | `{ server }` or 404 (owner only) |
| `POST /hosting/servers/:slug/weeks { weeks }` | buy 1-52 more weeks of Plus: `paid_until = max(now, paid_until) + weeks * 7 days`. Works while active, overdue or read-only (read-only is switched off at once) and on a Starter server (= upgrade). `400 insufficient_balance { cost, balance }` |
| `PATCH /hosting/servers/:slug { plan: "starter" }` | switch to free Starter now, no refund (`403 starter_limit_reached` when the account has no free slot; `plan: "plus"` is `400 use_weeks`) |
| `POST /hosting/servers/:slug/restart` | restart the container |
| `POST /hosting/servers/:slug/backup` | take a backup now (reason `manual`) -> `{ backup }` |
| `DELETE /hosting/servers/:slug { confirm: slug }` | backs up first (reason `deleted`), then removes the container and its data; `{ ok, backup, reserved_until }`. The name stays the owner's for 30 days |
| `POST /hosting/backups/upload` | bearer + `CHAT`; multipart `file` (max 500 MB), `name` (1-80 characters), `url` (instance origin), optional `slug` (normal hosting slug syntax); `{ backup }`. Streamed to disk; validates ZIP directory and `bonfire-export-v1` manifest. No hostd required. Errors: `no_file`, `invalid_name`, `invalid_slug`, `invalid_instance`, `invalid_multipart`, `invalid_export` (400), `file_too_large` (413, `max_mb: 500`) |
| `GET /hosting/backups` | `{ backups: [ { id, slug, name, size, created_at, reason: "archived" or "manual" or "deleted" or "uploaded", url: <origin> or null, source: "hosted" or "uploaded" } ] }` |
| `GET /hosting/backups/:id/download` | the `bonfire-export-v1` zip (owner only) |
| `DELETE /hosting/backups/:id` | |

Staff (rank `admin` or `owner`): `GET /hosting/admin/servers` (every server + `owner`, `owner_user_id`), `PATCH /hosting/admin/servers/:slug { plan?, status?: "suspended" | "running", paid_until? }` (no charge; `paid_until: null` on Plus = never expires), `GET /hosting/admin/servers/:slug/logs?tail=` -> `{ logs }`, `GET|PATCH /hosting/admin/settings` (`{ plans, starter_limit_per_account }`; a plan patch is `{ plans: { plus: { price_credits, limits: {…} } } }`, `null` resets one). Transactions are recorded like Pro's: `from_user_id` = the payer, `to_user_id` NULL, positive amount, type `bonfire_hosting`, note `"<n>w Bonfire Plus: <slug>"`.

### 19.6 Backups and restores

Every plan can call `POST /hosting/servers/:slug/backup` (Starter included). Account backup records include `url` (origin or null) and `source: "hosted" | "uploaded"`. Clients can save an instance backup to their Velora account by downloading it with an **instance session**, then uploading the file to `POST VELORA/bonfire/hosting/backups/upload` with their **Velora bearer + CHAT**, multipart fields `file`, `name`, `url`, optional `slug`. The 500 MB limit applies only to this multipart route; the file streams to disk and archive validation reads bounded directory/manifest data. Saved records use `reason: "uploaded"`, count toward the shared 10-per-account/180-day retention, and can be listed/downloaded/deleted without hostd. For older hosted records `url` uses the configured hosting origin when available. No tokens are exchanged between services.

To restore a saved account backup into an existing instance: download `GET VELORA/bonfire/hosting/backups/:id/download` with the Velora bearer, then send that ZIP as multipart `file` to `POST INSTANCE/api/v1/instance/restore` with the owner's instance session (section 5b). To create a new hosted server from either an uploaded or hosted backup, use the existing `restore_backup` field below.

A backup is a normal `bonfire-export-v1` zip (§9: settings, channels, roles, emojis, members, messages, files). Velora keeps them under `BONFIRE_BACKUP_DIR` (default `/opt/velora-data/bonfire-backups`) in table `bonfire_hosted_backups`: 180 days, at most 10 per account (oldest removed first). The container produces one with `node src/cli.js export <out.zip>` (exit 3 = no community yet, nothing to save); hostd runs it with `docker exec` and streams the file to Velora.

**Restore** = `POST /hosting/servers { …, restore_backup: <id> }`: hostd receives the zip, copies it to `/data/import.zip` of the new container and starts it with `BONFIRE_IMPORT_ON_BOOT=/data/import.zip`. On a boot where the instance has **no community yet**, it imports the zip as the owner (`BONFIRE_OWNER`) and deletes the file. Members who sign in again get their roles back.

### 19.7 bonfire-hostd (Velora -> Docker host)

`Authorization: Bearer <HOSTD_SECRET>` on `HOSTD_API_PORT` (8090): `POST /instances { slug, owner_principal, plan, limits, velora_url, public_url, env?, restore? }`, `GET /instances`, `GET /instances/:slug`, `PATCH /instances/:slug { plan?, limits?, read_only?, env? }` (recreates the container, same data), `POST /instances/:slug/{start,stop,restart}`, `DELETE /instances/:slug[?purge=1]`, `GET /instances/:slug/logs?tail=`, `POST /instances/:slug/backup` (the zip, or `204`), `PUT /imports/:slug` (the zip for a restore). A reverse proxy on `HOSTD_PROXY_PORT` (8080) routes `<slug>.<HOSTD_DOMAIN>` to the container, WebSockets included (`unknown_instance` 404, `instance_stopped` 503). See `bonfire-hostd/README.md`.

### 19.8 When paid time runs out

Like Velora Pro with credits, Plus is prepaid and **never renews automatically**. After `paid_until`:

1. **`overdue`** (2 days): the server keeps working normally.
2. **`read_only`** (the next 7 days): hostd recreates the container with `BONFIRE_READ_ONLY=1` (§19.3). Buying weeks brings it straight back.
3. **`archived`**: Velora stores a backup (reason `archived`), hostd stops and removes the container and its data, `status` becomes `deleted`. The name stays the owner's for 30 days; restoring the backup into a new server (§19.6) brings it back.

`read_only_at = paid_until + 2 days`, `archive_at = read_only_at + 7 days` (null for a free server). The owner is notified 2 days before `paid_until`, on overdue, on read-only and on archive. The job runs hourly; a failed backup keeps the server read-only and retries (nothing is removed without a backup). Starter servers never expire.

### 19.9 Maintenance mode (Velora)

Staff can put Velora in maintenance: `GET /admin/maintenance` -> `{ on, message, env_forced }`, `PUT /admin/maintenance { on, message? }` (rank `admin` / `owner`). Env `VELORA_MAINTENANCE=1|0` overrides the stored toggle (`env_forced: true`). While on, everyone except those staff gets `503` with `Retry-After: 600`: a page for browser navigations, `{ "error": "maintenance", "message"? }` for API calls (including `POST /bonfire/instance-token`, so instances wait), and WebSockets are closed with `4503` after auth. Always open: `/health`, `/.well-known/bonfire/jwks.json`, `/bonfire/relay/*` (instances keep working), `/login`, `/auth/*` except registration, `/assets/*`. Signed-in staff pass with their bearer token; the maintenance page offers them "Continue as staff" (`POST /admin/maintenance/bypass` sets a 12 hour cookie).
