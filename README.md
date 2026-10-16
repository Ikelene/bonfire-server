# bonfire-server

A small, self-hostable chat server: communities, text + voice channels, roles and permissions, invites, join requests, uploads, message signing and full export / import. One Node process, one SQLite file, no external services (voice uses your own Cloudflare Realtime account).

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
| `name`, `description`, `icon_url` | | shown in discovery |
| `public_url` | `http://localhost:<PORT>` | the origin clients reach you at. **Set this in production** (https). It is the JWT audience and the base of upload URLs |
| `accounts_mode` | `local` | `local` (accounts on this instance) or `velora` (Velora sign-in). Changing it needs a restart; accounts of the other kind can no longer log in |
| `velora_url` | `https://velora.ikelene.net` | issuer for Velora mode |
| `registration` | `open` | local mode: `open` / `closed` (always open while unclaimed) |
| `community_creation` | `everyone` | `everyone` / `admins` |
| `auto_join` | `[]` | community ids (`sid`) every user joins on first login, whatever the join policy |
| `max_upload_mb` | `25` | instance ceiling (1–500); each community also has `upload_max_mb` |
| `voice` | empty | `{ cf_app_id, cf_app_secret, cf_turn_key_id, cf_turn_token }` — Cloudflare Realtime SFU app + TURN key. Secrets are write-only over the API |

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

## Restart behaviour

`POST /api/v1/instance/restart` (admins) answers `202`, tells connected clients `instance_restarting`, closes their sockets with code `4010` and exits with **code 75**. Something must start it again: Docker's `restart: unless-stopped`, systemd `Restart=always`, or the `npm run dev` loop. On `SIGTERM`/`SIGINT` the server shuts down cleanly (sockets closed with 1001, database flushed) and exits 0.

## Data, export and import

Everything is in `DATA_DIR`; back it up by copying it while the process is stopped (or use SQLite's online backup). A community's owner can download `GET /api/v1/servers/:sid/export` (a `bonfire-export-v1` zip: settings, channels, roles, emojis, members, messages with reactions/pins/signatures, local files) and anyone allowed to create communities can `POST /api/v1/import` it into any instance — including exports from Velora's built-in chat.

## Development

```sh
npm test            # node --test: permissions, JWT, signing, voice (stubbed Cloudflare), HTTP+WS end to end
npm run dev         # restarts on exit code 75
```

Source layout: `src/index.js` (boot), `config.js`, `db.js` (migrations via `PRAGMA user_version`), `auth.js`, `perms.js` (pure permission algorithm), `communities.js`, `messages.js`, `signing.js`, `uploads.js`, `gateway.js`, `voice.js`, `export.js`, `routes/*.js`.
