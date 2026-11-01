#!/bin/sh
# Creates .env from .env.example with fresh random secrets. Refuses to overwrite an existing .env.
# usage: scripts/init-env.sh   (run from anywhere; writes next to .env.example)
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXAMPLE="$ROOT/.env.example"
TARGET="$ROOT/.env"

command -v openssl >/dev/null 2>&1 || { echo "error: openssl is required" >&2; exit 1; }
[ -f "$EXAMPLE" ] || { echo "error: $EXAMPLE not found" >&2; exit 1; }
if [ -e "$TARGET" ]; then
  echo "error: $TARGET already exists; not overwriting it (delete it first to start over)." >&2
  exit 1
fi

hex() { openssl rand -hex 32; }
# base64 minus / + = so the value is safe inside a postgres:// URL.
password() { openssl rand -base64 24 | tr -d '/+=\n'; }

umask 077
sed \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(password)|" \
  -e "s|^APP_DB_PASSWORD=.*|APP_DB_PASSWORD=$(password)|" \
  -e "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(hex)|" \
  -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(hex)|" \
  -e "s|^SETUP_TOKEN=.*|SETUP_TOKEN=$(hex)|" \
  "$EXAMPLE" > "$TARGET"

echo "Wrote $TARGET."
echo "BACK UP ENCRYPTION_KEY and BETTER_AUTH_SECRET together with your database backups: without them"
echo "stored bank sessions, keys, 2FA enrolments and MCP signing keys cannot be decrypted."
echo "Keep SETUP_TOKEN: you need it once at /setup."
