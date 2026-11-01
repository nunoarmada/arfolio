#!/bin/sh
# Smoke-tests the Docker Compose install from a scratch copy: init-env -> `docker compose up -d` ->
# health + /setup -> `down -v`. Pulls ghcr.io/nunoarmada/arfolio:${ARFOLIO_VERSION:-latest}; to test a
# local build, tag it ghcr.io/nunoarmada/arfolio:dev and run with ARFOLIO_VERSION=dev.
# usage: scripts/compose-smoke.sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TIMEOUT="${SMOKE_TIMEOUT:-120}"
DIR="$(mktemp -d)"
PORT="${SMOKE_PORT:-$((20000 + $$ % 20000))}"
export COMPOSE_PROJECT_NAME="arfolio-smoke-$$"
export ARFOLIO_PORT="$PORT"

dc() { docker compose --project-directory "$DIR" -f "$DIR/compose.yaml" "$@"; }
cleanup() {
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; dc logs --tail 40 >&2 2>&1 || true; exit 1; }

mkdir -p "$DIR/scripts"
cp "$ROOT/compose.yaml" "$ROOT/.env.example" "$DIR/"
cp "$ROOT/scripts/init-env.sh" "$DIR/scripts/"
cd "$DIR"

# init-env: writes .env with every secret filled, and refuses to overwrite it.
./scripts/init-env.sh >/dev/null || fail "init-env.sh failed"
for key in POSTGRES_PASSWORD APP_DB_PASSWORD BETTER_AUTH_SECRET ENCRYPTION_KEY SETUP_TOKEN; do
  grep -Eq "^$key=[^[:space:]]{24,}\$" .env || fail "$key not generated in .env"
done
cp .env .env.before
if ./scripts/init-env.sh >/dev/null 2>&1; then fail "init-env.sh overwrote an existing .env"; fi
cmp -s .env .env.before || fail "existing .env was modified"
rm .env.before
echo "ok: init-env.sh"

dc config -q || fail "compose.yaml does not validate"
dc up -d

wait_http() {
  name="$1"; url="$2"; want="$3"; waited=0
  while [ "$waited" -lt "$TIMEOUT" ]; do
    if [ "$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$url" || true)" = "$want" ]; then
      echo "ok: $name $url -> $want"
      return 0
    fi
    sleep 2; waited=$((waited + 2))
  done
  fail "$name did not return $want at $url within ${TIMEOUT}s"
}
wait_http web "http://127.0.0.1:$PORT/api/health" 200
wait_http setup "http://127.0.0.1:$PORT/setup" 200

# migrate ran once and exited 0; the worker is up.
migrate_exit="$(docker inspect -f '{{.State.ExitCode}}' "$(dc ps -aq migrate)")"
[ "$migrate_exit" = "0" ] || fail "migrate exited $migrate_exit"
[ -n "$(dc ps -q --status running worker)" ] || fail "worker is not running"
echo "ok: migrate exited 0, worker running"

# Security posture: non-root, read-only root filesystem.
for svc in web worker; do
  cid="$(dc ps -q "$svc")"
  [ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$cid")" = "true" ] || fail "$svc root FS is writable"
  [ "$(docker exec "$cid" id -u)" = "1001" ] || fail "$svc does not run as uid 1001"
done
echo "ok: web and worker run as 1001 on a read-only root FS"

# Published on loopback only by default.
dc port web 3000 | grep -q '^127\.0\.0\.1:' || fail "web is not bound to 127.0.0.1"
echo "compose smoke test passed"
