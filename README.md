# bonfire-server

A small, self-hostable chat server: communities, text + voice channels, special channel types (logs, welcome, link, roles shop, starboard), roles and permissions, invites, join requests, uploads, webhooks, bots, soundboard, link previews, mentions, message signing and full export / import. One Node process, one SQLite file, no external services (voice uses your own Cloudflare Realtime account).

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
| `BONFIRE_TRUST_PROXY` | `1` = take the client IP from `X-Forwarded-For` (set this behind a reverse proxy, otherwise per-IP rate limits see only the proxy) |

Put it behind a TLS-terminating reverse proxy (nginx, Caddy, Cloudflare Tunnel…). WebSocket path is `/gateway`; both HTTP and WS must be proxied.

### Velora mode

Users sign in with a short-lived instance token minted by Velora (`POST /bonfire/instance-token`). The server verifies the Ed25519 JWT against Velora's JWKS (`iss`, `aud` = your `public_url`, `exp`, one-time `jti`). Message signing (§8) is available in this mode only.

### Local mode

Usernames are 2–32 chars of `[a-z0-9_.]`; passwords are 8–200 chars, hashed with scrypt (N=16384, r=8, p=1). There is no email and no password reset — the instance owner can only recreate accounts. (Message signing is off in this mode.)

### Optional: the YouTube player (yt-dlp)

The client can play YouTube links "without YouTube": the instance downloads the video with [yt-dlp](https://github.com/yt-dlp/yt-dlp) and streams it itself (no ads, no trackers, the viewer never contacts YouTube). It is **off unless yt-dlp is installed** — **install yt-dlp to enable it** (`pip install yt-dlp`, your package manager, or the single binary on PATH; add `ffmpeg` for merged 720p video), then restart or touch the `youtube` settings. The instance runs `yt-dlp --version` at boot and on settings changes and advertises `features.youtube` in `/.well-known/bonfire`; while it is off the `/api/v1/yt/*` routes answer `503 {"error":"youtube_unavailable"}`. Set `youtube.ytdlp_path` for a binary that is not on PATH, or `youtube.enabled: false` to switch it off. Downloads are capped (2 h, 720p, 900 MB, two at a time), kept 24 h after the last watch and trimmed to `cache_max_gb`. Stream links are HMAC-signed with a per-process secret, so they stop working on a restart (the player just asks again). See PROTOCOL §15.

## Restart behaviour

`POST /api/v1/instance/restart` (admins) answers `202`, tells connected clients `instance_restarting`, closes their sockets with code `4010` and exits with **code 75**. Something must start it again: Docker's `restart: unless-stopped`, systemd `Restart=always`, or the `npm run dev` loop. On `SIGTERM`/`SIGINT` the server shuts down cleanly (sockets closed with 1001, database flushed) and exits 0.

## Data, export and import

Everything is in `DATA_DIR`; back it up by copying it while the process is stopped (or use SQLite's online backup). A community's owner can download `GET /api/v1/servers/:sid/export` (a `bonfire-export-v1` zip: settings, channels, roles, emojis, members, messages with reactions/pins/signatures, local files) and anyone allowed to create communities can `POST /api/v1/import` it into any instance — including exports from Velora's built-in chat.

## Extension points

Later waves (bridges, push, payments, imports) plug into three places and need no changes to the core:

```js
const messages = require('./src/messages');
const notify = require('./src/notify');

// 1. messages.onPost(fn): runs after ANY message is created - people, bots, webhooks, system lines, bridged posts.
//    fn(message, { ch, c, snap }, { system, webhook, bridged, userId }); returns an unsubscribe function.
const off = messages.onPost((msg, ctx, meta) => { /* e.g. relay to Discord unless meta.bridged === 'discord' */ });

// 2. messages.postBridged(channel, { platform, name, avatar, body, attachments, embeds? }): a message from outside.
//    `channel` is a cid, a channel row or a { ch, c, snap } context. It shows as a name-only author with
//    author.bridge = platform, goes through the gateway like any message, and fires onPost with meta.bridged = platform.
//    attachments are trusted as given: [{ url, type: 'image'|'gif'|'video'|'audio'|'file', name, size, width, height }].
messages.postBridged('c0123456789', { platform: 'discord', name: 'Zed', avatar: 'https://…', body: 'hi' });

// 3. notify.notifyOffline(userIds, payload): called for members a message pings who have no gateway socket open.
//    payload is the chat_mention event. A no-op until a push backend registers itself:
notify.setOfflineHandler((userIds, payload) => { /* send web push */ });
```

Online members get the `chat_mention` gateway event themselves; `notifyOffline` is only for the rest, already filtered by their notification level / mute settings. The Minecraft (`game`) channel type is also left for a later wave: today it is not an accepted type.

## Features at a glance

- **Channel types** `text`, `voice`, `logs`, `welcome` (join / leave notices), `link`, `roles` (self-assign shop; priced roles answer `402 payment_unavailable` until payments land), `starboard` (⭐ threshold reposting). PROTOCOL §6.1.
- **Webhooks**: Discord-compatible `POST /api/v1/webhooks/:wid/:token` (embeds, files, `?wait=true`, 30/min per hook). §13.
- **Bots**: instance-local `b:<n>` accounts with a Discord-dialect REST API at `/bot/v1` and gateway at `/bot/gateway`. §14.
- **Soundboard**: per-community sounds (mp3 / wav / ogg / flac / m4a, ≤ 5.2 s), played into a voice room with the `voice_sound` frame. §6.2.
- **Link previews** with SSRF protection: `GET /api/v1/unfurl?url=` (needs a session). §6.3.
- **Mentions** (`@user`, `@everyone`, `@here`, `@role`, replies) as `chat_mention` events, per-channel / per-community notification levels and mutes.

## Development

```sh
npm test            # node --test: permissions, JWT, signing, voice (stubbed Cloudflare), HTTP+WS end to end,
                    # features (types, shop, starboard, webhooks, soundboard, mentions, bots), unfurl SSRF, youtube (fake yt-dlp)
npm run dev         # restarts on exit code 75
```

Source layout: `src/index.js` (boot), `config.js`, `db.js` (migrations via `PRAGMA user_version`), `auth.js`, `perms.js` (pure permission algorithm), `communities.js`, `messages.js`, `signing.js`, `uploads.js`, `gateway.js`, `voice.js`, `export.js`, `notify.js` (mentions + the offline hook), `identity.js`, `starboard.js`, `webhooks.js`, `soundboard.js`, `unfurl.js`, `bots.js`, `youtube.js`, `routes/*.js` (`extras.js` management routes, `hooks.js` webhook execute, `botapi.js` the bot REST).
