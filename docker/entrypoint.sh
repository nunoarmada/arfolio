#!/bin/sh
# Dispatches the container command. `exec` replaces the shell so SIGTERM reaches node directly.
set -eu

usage() {
  echo "usage: entrypoint.sh {web|worker|migrate}" >&2
  exit 64
}

[ $# -ge 1 ] || usage

case "$1" in
  web)
    # .next/cache is a symlink to /tmp/next-cache (read-only root FS), so create the target.
    mkdir -p /tmp/next-cache
    exec node /app/web/apps/web/server.js
    ;;
  worker) exec node /app/worker/dist/index.js ;;
  migrate) exec node /app/worker/node_modules/@arfolio/db/dist/migrate.js ;;
  *) usage ;;
esac
