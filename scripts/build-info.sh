#!/bin/bash
# Print the build identity of bonfire-server as JSON (run inside the Velora git checkout, any cwd). Used by /root/bonfire-release.sh
# on the Proxmox host (ships the source to the Docker LXC 230, which runs rebuild-image.sh).
#   commit/commit_date = last commit touching bonfire-server/;  dirty = uncommitted changes there;
#   build_id = commit, or commit+<hash of the files> when dirty, so a dirty rebuild still counts as a new build.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
D=bonfire-server
COMMIT=$(git log -1 --format=%H -- $D); CDATE=$(git log -1 --format=%cI -- $D); MSG=$(git log -1 --format=%s -- $D | cut -c1-190)
VER=$(node -p "require('./$D/package.json').version")
if [ -n "$(git status --porcelain -- $D ':!*.bak-*' ':!*.pre-*' | head -1)" ]; then DIRTY=true; else DIRTY=false; fi
BID=$COMMIT
if [ $DIRTY = true ]; then
  H=$(cd $D && find src package.json package-lock.json Dockerfile -type f ! -name '*.bak-*' | sort | xargs sha1sum | sha1sum | cut -c1-8)
  BID="$COMMIT+$H"
fi
node -e "console.log(JSON.stringify({version:process.argv[1],commit:process.argv[2],commit_short:process.argv[2].slice(0,7),commit_date:process.argv[3],built_at:new Date().toISOString(),dirty:process.argv[4]==='true',build_id:process.argv[5],message:process.argv[6]},null,2))" "$VER" "$COMMIT" "$CDATE" "$DIRTY" "$BID" "$MSG"
