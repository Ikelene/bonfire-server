# Local bot administration

Run `node src/cli.js --help` in the server directory. This is an administrator
tool authorized by filesystem access to the existing `BONFIRE_DATA` directory;
it does not need an owner login or start any network clients.

Back up production files before deploying the CLI. Every CLI mutation also
creates a consistent SQLite snapshot (including committed WAL data) under
`BONFIRE_DATA/cli-backups/bonfire.db.bak-<UTC timestamp>-<random suffix>`.
The directory is mode 0700 and snapshots are mode 0600 on Linux. These contain
private instance data: keep them out of Git. They are retained until removed
by the operator; monitor disk space.

```sh
docker exec bonfire-chat node src/cli.js bot create Mahi --owner v:1 --avatar https://example.org/mahi.png
docker exec bonfire-chat node src/cli.js bot add b:42 s0123456789 --role r0123456789
docker exec bonfire-chat node src/cli.js bot role b:42 s0123456789 r0123456789 --remove
docker exec bonfire-chat node src/cli.js bot token b:42
```

IDs and URLs above are examples; use the actual imported community and role
IDs. `create` accepts `--description`. `add` accepts repeated `--role` flags,
validates roles within that community, rejects bans and silently adds membership
without welcome messages. Role assignments use the existing permission checks.
The owner defaults to the recorded instance owner and must already exist and
be permitted to manage bots. Creating an existing name fails without rotating
its token. Membership and role additions can be retried.

Creation and rotation return JSON containing the token **once on stdout**;
diagnostics and backup paths go to stderr. Capture stdout directly into a
root-only file outside the repository; do not paste it into chat or logs.
The database stores only its hash. Rotation is a separate operation and
invalidates the previous token for new REST/gateway authentication.

Restart `bonfire-chat` after CLI changes, **especially token rotation**. The CLI
runs in a different process and cannot disconnect already authenticated gateway
sockets or notify existing clients. Restarting closes those sockets and refreshes
member views. Restart the bot service after installing its new configuration.
Use authenticated GET `/bot/v1/users/@me`, GET `/bot/v1/users/@me/guilds`, and
gateway `READY` / `GUILD_CREATE` plus heartbeat acknowledgements to check a
connection without sending a message.

For rollback, stop the instance before restoring a snapshot, retain the current
database and its WAL/SHM files as a separate backup, and restore the chosen
snapshot as `bonfire.db` with the original ownership and permissions. Do not
leave the old WAL/SHM files beside the restored database. Restart and check
`/health`. A database restore also restores the previous token hashes; restore
matching bot configurations when rolling back credentials.
