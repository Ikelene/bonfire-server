# bonfire-server

A small, self-hostable chat server: communities, text + voice channels, special channel types (logs, welcome, link, roles shop, starboard, Minecraft), roles and permissions, invites, join requests, uploads, webhooks, bots, Discord / Fluxer / CloudLink bridges, soundboard, link previews, mentions, message signing and full export / import. One Node process, one SQLite file, no external services (voice uses your own Cloudflare Realtime account).

It implements the **Bonfire Instance Protocol v1** — see [PROTOCOL.md](./PROTOCOL.md) — so the Bonfire web, desktop and Android clients can talk to it. Licensed AGPL-3.0-or-later.

## Quick start

Needs **Node.js 22.13 or newer**. There are no native dependencies (storage is Node's built-in `node:sqlite`), so nothing gets compiled and it installs the same on Windows, macOS and Linux.

```sh
npm install
npm start            # http://localhost:4100, data in ./data
```

On first boot an unclaimed instance prints a **setup code** (`XXXX-XXXX`) to the console and writes it to `data/setup-code.txt`:

```
  This instance is not claimed yet. Log in, then claim it with the setup code:
      7Q3K-M9XD
```

1. Sign in (local mode: create an account; Velora mode: sign in with Velora).
2. Claim the instance: `POST /api/v1/instance/claim {"code":"7Q3K-M9XD"}` (the Bonfire client has a button for it). You become the owner and an admin, and the code file is deleted.
3. Set up the instance's community: `POST /api/v1/servers {"name":"…"}` or `POST /api/v1/import` (an export zip). **An instance hosts exactly one community** — only instance admins can create/import it, and only while none exists (`409 community_exists` otherwise). You, the instance owner, own it. Deleting it returns the instance to "not set up" (discovery shows `community: null`) so it can be created or imported again. Everyone else joins it through its `join_policy` or an invite code (there is no auto-join).

Or skip the code: set `BONFIRE_OWNER=v:<velora user id>` and the instance boots already claimed by that Velora user.

### Docker

```sh
docker compose up -d --build
docker compose logs bonfire | grep -A2 "not claimed"     # the setup code
```

`docker-compose.yml` mounts `./data` at `/data` and uses `restart: unless-stopped` — keep that policy, the admin "restart" button relies on it (see below).

## Configuration

Settings live in **`DATA_DIR/config.json`** (created on first boot). You can edit it by hand — the server watches the file and reloads it — or change it from the admin API (`GET/PATCH /api/v1/instance/settings`), which rewrites the file.

| key | default | notes |
|---|---|---|
| `name`, `description`, `icon_url` | | shown in discovery. They are the **same values as the community's** name / description / icon: editing either side (this file, `PATCH /instance/settings`, or `PATCH /servers/:sid` + icon upload) updates the other. Name ≤ 60 chars, description ≤ 300 |
| `public_url` | `http://localhost:<PORT>` | the origin clients reach you at. **Set this in production** (https). It is the JWT audience and the base of upload URLs |
| `accounts_mode` | `local` | `local` (accounts on this instance) or `velora` (Velora sign-in). Changing it needs a restart; accounts of the other kind can no longer log in |
| `velora_url` | `https://velora.ikelene.net` | issuer for Velora mode |
| `registration` | `open` | local mode: `open` / `closed` (always open while unclaimed) |
| `max_upload_mb` | `25` | instance ceiling (1–500); each community also has `upload_max_mb` |
| `voice` | empty | `{ cf_app_id, cf_app_secret, cf_turn_key_id, cf_turn_token }` — Cloudflare Realtime SFU app + TURN key. Secrets are write-only over the API |
| `youtube` | `{ enabled: true, ytdlp_path: "yt-dlp", cache_dir: "", cache_max_gb: 5 }` | the optional YouTube player, see below. `cache_dir` empty = `DATA_DIR/cache/yt` |
| `velora_registration` | `auto` | `auto`: register with `velora_url` and use its relays (push, paid roles, daily credits, voice broker, directory). `off`: never contact Velora. See "Velora relays" below |
| `listed` | `false` | list the instance in Velora's public Bonfire directory (same value as the community's `listed`) |
| `tags` | `[]` | up to 8 directory tags |

### Environment variables

| variable | meaning |
|---|---|
| `BONFIRE_DATA` | data directory (default `./data`): `bonfire.db`, `uploads/`, `config.json`, `setup-code.txt` |
| `PORT` | listen port (default `4100`) |
| `BONFIRE_HOST` | Address to listen on. Default `::` (IPv4 + IPv6), falling back to `0.0.0.0` when the host has no IPv6 |
| `BONFIRE_PUBLIC_URL` | overrides `public_url` |
| `BONFIRE_VELORA_URL` | overrides `velora_url` |
| `BONFIRE_ACCOUNTS_MODE` | overrides `accounts_mode` (`velora` / `local`) |
| `BONFIRE_OWNER` | `v:<velora id>`: boot already claimed by that user (ignored if the instance is already claimed) |
| `BONFIRE_VELORA_REGISTRATION` | overrides `velora_registration` (`auto` / `off`) |
| `BONFIRE_TRUST_PROXY` | `1` = take the client IP from `X-Forwarded-For` (set this behind a reverse proxy, otherwise per-IP rate limits see only the proxy) |
| `BONFIRE_DISCORD_TOKEN`, `BONFIRE_FLUXER_TOKEN` | bridge bot tokens, used when none is saved in the instance settings (`PATCH /api/v1/bridge/settings`) |
| `BONFIRE_MANAGED`, `BONFIRE_PLAN`, `BONFIRE_LIMITS` | Velora-hosted ("managed") instances: plan limits (member cap, upload size, emojis, sounds, bots, bridges, own voice keys) and locked settings. See "Velora-hosted" below, PROTOCOL §19 |
| `BONFIRE_READ_ONLY` | `1` = refuse every write (reading, signing in and the export still work) |
| `BONFIRE_IMPORT_ON_BOOT` | path of a `bonfire-export-v1` zip: imported once, as the owner, on a boot where the instance has no community yet, then deleted |
| `BONFIRE_DEV` | `1` = development only: CloudLink bridges may connect to `ws://localhost`, private addresses and any port |

Put it behind a TLS-terminating reverse proxy (nginx, Caddy, Cloudflare Tunnel…). WebSocket paths are `/gateway`, `/bot/gateway` and `/game-gateway` (Minecraft); both HTTP and WS must be proxied.

### Velora mode

Users sign in with a short-lived instance token minted by Velora (`POST /bonfire/instance-token`). The server verifies the Ed25519 JWT against Velora's JWKS (`iss`, `aud` = your `public_url`, `exp`, one-time `jti`). Message signing (§8) is available in this mode only.

### Velora relays

Unless `velora_registration` is `off`, the instance registers itself with Velora (`velora_url`) in **both** accounts modes, in the background once it is listening (it retries with backoff and never blocks startup). It proves it owns `public_url` by publishing its key (`DATA_DIR/keys/instance.key`, generated on first boot; back it up) in `/.well-known/bonfire`, so `public_url` must be reachable from Velora. Registered, it gets:

- **Push**: Velora users who are pinged while not connected get a phone / browser notification (at most one per channel per 30 s; they control it per instance in Bonfire).
- **Paid roles**: priced roles in a roles shop are paid with Velora credits through a pay request the buyer approves on Velora; the instance verifies Velora's signed receipt and grants the role. Credits go to the instance owner's Velora account once the owner links it: the instance signs a short-lived owner attestation (`GET /api/v1/instance/owner-attestation`) and the owner presents it to Velora themselves (`POST /bonfire/instances/payout`), so no Velora token ever goes to the instance. Otherwise credits go to Velora.
- **Daily credits** for chatting (only for instances Velora staff marked `trusted`).
- **Voice without your own Cloudflare account**: with no `voice` keys set, voice goes through Velora's broker (free monthly minutes for untrusted instances). Your own keys always win.
- **Directory**: set `listed` to show up in Velora's public directory.
- **Import from Discord / Fluxer**: prepare the import on Velora, then hand the ticket to `POST /api/v1/import/velora`.

`GET /api/v1/instance/settings` shows the state under `velora` (`registered`, `instance_id`, `trusted`, voice minutes, `last_error`). Details: PROTOCOL §12.11.

### Velora-hosted

Velora can run instances for people (`bonfire-hostd/` starts the containers). Such an instance is started with `BONFIRE_MANAGED=1`, `BONFIRE_PLAN` and `BONFIRE_LIMITS`: it enforces the plan (member cap `403 member_cap_reached`, uploads, emoji / sound / bot counts `403 plan_limit`, no bridges, no own voice keys), locks `accounts_mode`, `public_url`, `velora_url` and `velora_registration` (`403 managed_setting`), and reports `managed` in `/.well-known/bonfire`. `BONFIRE_READ_ONLY=1` makes it read-only when the owner stops paying. Admins get the voice quota (`voice_quota`) on the gateway so a client can warn at 80 %. `node src/cli.js export <out.zip>` writes the community as a `bonfire-export-v1` zip (that is what the host's backups run), and `BONFIRE_IMPORT_ON_BOOT` restores one. Details: PROTOCOL §19.

### Bridges: Discord, Fluxer, CloudLink

Bring your **own bot** for Discord and/or Fluxer: create a bot (Discord: enable the *Message Content* intent), then save its token as an instance admin with `PATCH /api/v1/bridge/settings {"discord":{"token":"…"}}` (or `fluxer`). The token is checked against `/users/@me`, stored in the database (never in `config.json`), and never shown again (`GET` returns `********` + its last 4 characters; `null` removes it). The instance then keeps a gateway connection for that bot. Add the bot to your server with the invite link from `GET /api/v1/bridge/platforms` (it needs View channels, Send, Read history, Embed links, Attach files, Manage messages and **Manage webhooks**), and link it in Server settings > Bridge (`PUT /api/v1/bridge/servers/:sid`, Manage server): channels with the same name are linked automatically, others per channel. Messages, replies, edits and deletes go both ways; people over there show up with their name and picture, Bonfire people post over there through a "Bonfire bridge" webhook. PROTOCOL §16.

A `logs` channel can also bridge a **CloudLink** chat (`config: {"mode":"cloudlink","url":"wss://…","room":"","username":""}`; at most 3 per community; public `ws`/`wss` servers on ports 80 / 443 only). PROTOCOL §17.

### Minecraft (Bonfire Link)

Install the Bonfire Link plugin / mod on your Minecraft server and run **`bonfire server https://your.instance`** in its console. The server connects out to `/game-gateway` (no open ports) and appears under **Connected game servers**; create a "Game server" channel and pick it (or use a claim code: `bonfire link XXXX-XXXX`). Channels can show join info, a live console (Manage server only, every command audited) or synced chat. Unlinked servers that haven't connected for 30 days are forgotten. PROTOCOL §18. `node scripts/game-gateway-sim.js --url http://localhost:4100` pretends to be a Minecraft server for testing.

### Local mode

Usernames are 2–32 chars of `[a-z0-9_.]`; passwords are 8–200 chars, hashed with scrypt (N=16384, r=8, p=1). There is no email and no password reset — the instance owner can only recreate accounts. (Message signing is off in this mode.)

### Optional: the YouTube player (yt-dlp)

The client can play YouTube links "without YouTube": the instance downloads the video with [yt-dlp](https://github.com/yt-dlp/yt-dlp) and streams it itself (no ads, no trackers, the viewer never contacts YouTube). It is **off unless yt-dlp is installed** — **install yt-dlp to enable it** (`pip install yt-dlp`, your package manager, or the single binary on PATH; add `ffmpeg` for merged 720p video), then restart or touch the `youtube` settings. The instance runs `yt-dlp --version` at boot and on settings changes and advertises `features.youtube` in `/.well-known/bonfire`; while it is off the `/api/v1/yt/*` routes answer `503 {"error":"youtube_unavailable"}`. Set `youtube.ytdlp_path` for a binary that is not on PATH, or `youtube.enabled: false` to switch it off. Downloads are capped (2 h, 720p, 900 MB, two at a time), kept 24 h after the last watch and trimmed to `cache_max_gb`. Stream links are HMAC-signed with a per-process secret, so they stop working on a restart (the player just asks again). See PROTOCOL §15.

## Restart behaviour

`POST /api/v1/instance/restart` (admins) answers `202`, tells connected clients `instance_restarting`, closes their sockets with code `4010` and exits with **code 75**. Something must start it again: Docker's `restart: unless-stopped`, systemd `Restart=always`, or the `npm run dev` loop. On `SIGTERM`/`SIGINT` the server shuts down cleanly (sockets closed with 1001, database flushed) and exits 0.

## Instance backups and upload limits

Every instance, including self-hosted and both hosted plans, has admin-only portable backups. `POST /api/v1/instance/backups { note? }` creates one, `GET /api/v1/instance/backups` lists them, and `GET /api/v1/instance/backups/:id/download` downloads the ZIP. `DELETE /api/v1/instance/backups/:id` removes it. They live under `DATA_DIR/backups/`; instance settings `max_backups` defaults to 10 (range 1-50, oldest pruned first).

Only the instance owner can restore: `POST /api/v1/instance/backups/:id/restore`, or upload an export ZIP (multipart `file`, max 500 MB) to `POST /api/v1/instance/restore`. Restore takes a safety backup (`before restore`), replaces the community in a transaction, returns `{ ok: true, sid }`, and closes gateway sockets for a fresh reconnect (`instance_restarting`, code 4010). Read-only instances still allow backup list/download. See PROTOCOL section 5b for response shapes and errors.

Roles accept nullable `upload_max_mb` (integer 1-500) on create/PATCH. A member gets the maximum of the community default and their roles' overrides, capped by the instance and managed plan; the owner gets the ceiling. `GET /api/v1/servers/:sid` keeps `server.upload_max_mb` as the community default for settings, exposes the caller's effective value as `server.my_upload_max_mb`, and returns `server.upload_ceiling_mb` (the minimum of the instance ceiling and managed plan cap) for the role editor. Hosted Starter stays at 10 MB; Plus now allows 250 MB. Role limits travel with exports, including compatibility with older backups.

Clients can save any instance ZIP to the owner's Velora account using `POST VELORA/bonfire/hosting/backups/upload` (Velora bearer + CHAT; multipart `file`, `name`, `url`, optional `slug`, 500 MB streamed to disk). Uploaded and hosted ZIPs share account retention and download/delete/restore flows. To restore an account backup into an existing instance, the client downloads it from Velora and sends it to the instance's restore route using the owner's instance session. Velora tokens never go to instances. PROTOCOL sections 19.5-19.6 describe both services.

## Data, export and import

Everything is in `DATA_DIR`; back it up by copying it while the process is stopped (or use SQLite's online backup). A community's owner can download `GET /api/v1/servers/:sid/export` (a `bonfire-export-v1` zip: settings, channels, roles, emojis, members, messages with reactions/pins/signatures, local files) and anyone allowed to create communities can `POST /api/v1/import` it into any instance — including exports from Velora's built-in chat.

## Extension points

Later waves (bridges, push, payments, imports) plug into these places and need no changes to the core (the Velora relays in `src/relay/` use `onPost` for daily credits and `setOfflineHandler` for push; the bridges in `src/bridge/` and Bonfire Link in `src/game/` use `onPost`, `onEdit`, `onDelete`, `postBridged` and `communities.onChannelsChanged`):

```js
const messages = require('./src/messages');
const notify = require('./src/notify');

// 1. messages.onPost(fn): runs after ANY message is created - people, bots, webhooks, system lines, bridged posts.
//    fn(message, { ch, c, snap }, { system, webhook, bridged, userId }); returns an unsubscribe function.
const off = messages.onPost((msg, ctx, meta) => { /* e.g. relay to Discord unless meta.bridged === 'discord' */ });

// 2. messages.postBridged(channel, { platform, name, avatar, body, attachments, embeds?, replyTo?, from?, sysKind? }): a message from outside.
//    (`from` shows as author.bridge_from, e.g. the Velocity backend a Minecraft chat line came from.)
//    `channel` is a cid, a channel row or a { ch, c, snap } context. It shows as a name-only author with
//    author.bridge = platform, goes through the gateway like any message, and fires onPost with meta.bridged = platform.
//    attachments are trusted as given: [{ url, type: 'image'|'gif'|'video'|'audio'|'file', name, size, width, height }].
messages.postBridged('c0123456789', { platform: 'discord', name: 'Zed', avatar: 'https://…', body: 'hi' });

// 3. notify.notifyOffline(userIds, payload): called for members a message pings who have no gateway socket open.
//    payload is the chat_mention event. src/relay/push.js registers the Velora push backend here:
notify.setOfflineHandler((userIds, payload) => { /* send web push */ });

// 4. messages.onEdit(fn(message, ctx)) / messages.onDelete(fn({ id, ch, c })): after an edit / delete (people, bots, bridges).
//    messages.editBridged(id, body) / messages.deleteBridged(id): change a bridged message when it changed where it came from.
// 5. communities.onChannelsChanged(fn(community)): after any channel create / edit / delete / layout change.
```

Online members get the `chat_mention` gateway event themselves; `notifyOffline` is only for the rest, already filtered by their notification level / mute settings.

## Features at a glance

- **Channel types** `text`, `voice`, `logs`, `welcome` (join / leave notices), `link`, `roles` (self-assign shop; priced roles are paid with Velora credits), `starboard` (⭐ threshold reposting), `game` (Minecraft). PROTOCOL §6.1.
- **Discord / Fluxer bridge** with your own bot: messages, replies, edits, deletes, pictures both ways, auto-linking channels by name. §16.
- **CloudLink bridge** in logs channels (gmsg both ways, `!online`, SSRF-guarded). §17.
- **Bonfire Link (Minecraft)**: `bonfire server <url>` connects a server; join-info card, live console with audit log, synced chat and join / death / advancement lines. §18.
- **Webhooks**: Discord-compatible `POST /api/v1/webhooks/:wid/:token` (embeds, files, `?wait=true`, 30/min per hook). §13.
- **Bots**: instance-local `b:<n>` accounts with a Discord-dialect REST API at `/bot/v1` and gateway at `/bot/gateway`. §14.
- **Soundboard**: per-community sounds (mp3 / wav / ogg / flac / m4a, ≤ 5.2 s), played into a voice room with the `voice_sound` frame. §6.2.
- **Link previews** with SSRF protection: `GET /api/v1/unfurl?url=` (needs a session). §6.3.
- **Mentions** (`@user`, `@everyone`, `@here`, `@role`, replies) as `chat_mention` events, per-channel / per-community notification levels and mutes.

## Development

```sh
npm test            # node --test: permissions, JWT, signing, voice (stubbed Cloudflare), HTTP+WS end to end,
                    # features (types, shop, starboard, webhooks, soundboard, mentions, bots), unfurl SSRF, youtube (fake yt-dlp),
                    # bridge (fake Discord REST + gateway), cloudlink (local CL4 server, SSRF), game (scripts/game-gateway-sim.js)
npm run dev         # restarts on exit code 75
```

Source layout: `src/index.js` (boot), `config.js`, `db.js` (migrations via `PRAGMA user_version`), `auth.js`, `perms.js` (pure permission algorithm), `communities.js`, `messages.js`, `signing.js`, `uploads.js`, `gateway.js`, `voice.js`, `export.js`, `notify.js` (mentions + the offline hook), `identity.js`, `starboard.js`, `webhooks.js`, `soundboard.js`, `unfurl.js`, `bots.js`, `youtube.js`, `relay/*.js` (Velora relays: `client.js` key + registration + signed requests, `push.js`, `daily.js`, `shop.js`, `broker.js`, `directory.js`, `import.js`), `bridge/*.js` (`platform.js` REST + gateway client, `bridge.js` Discord / Fluxer, `cloudlink.js`, `store.js` its tables), `game/*.js` (`game.js` data side, `gateway.js` the /game-gateway socket, `index.js` routes), `routes/*.js` (`extras.js` management routes, `hooks.js` webhook execute, `botapi.js` the bot REST). Bridge and game tables are created by their modules at boot (`CREATE TABLE IF NOT EXISTS`), not as `db.js` migrations.
