#!/bin/sh
# Smoke-tests the built image end to end: postgres -> `migrate` -> `worker` + `web` -> health endpoints.
# usage: scripts/image-smoke.sh <image>   (POSTGRES_IMAGE overrides the database image)
set -eu

IMAGE="${1:?usage: image-smoke.sh <image>}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:17-alpine}"
TIMEOUT="${SMOKE_TIMEOUT:-60}"
ID="arfolio-smoke-$$"
# Random per-run secrets (od is in coreutils, so no openssl needed on the runner).
rand_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
OWNER_PW="$(rand_hex 12)"
APP_PW="$(rand_hex 12)"
AUTH_SECRET="$(rand_hex 16)"
SETUP_TOKEN="$(rand_hex 12)"
ENC_KEY="$(rand_hex 32)"

cleanup() {
  docker rm -f "$ID-web" "$ID-worker" "$ID-db" >/dev/null 2>&1 || true
  docker network rm "$ID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

dump_logs() {
  for c in worker web; do
    echo "--- $c logs" >&2
    docker logs "$ID-$c" >&2 2>&1 || true
  done
}

# Polls `url` until it answers 200; fails (with container logs) after TIMEOUT seconds.
wait_http() {
  name="$1"; url="$2"; waited=0
  while [ "$waited" -lt "$TIMEOUT" ]; do
    if [ "$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$url" || true)" = "200" ]; then
      echo "ok: $name $url -> 200"
      return 0
    fi
    sleep 2; waited=$((waited + 2))
  done
  echo "FAIL: $name did not return 200 at $url within ${TIMEOUT}s" >&2
  dump_logs
  return 1
}

docker network create "$ID" >/dev/null
docker run -d --name "$ID-db" --network "$ID" -e POSTGRES_PASSWORD="$OWNER_PW" "$POSTGRES_IMAGE" >/dev/null
waited=0
# Over TCP: the init-time server only listens on the unix socket, so a socket check can pass too early.
until docker exec "$ID-db" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; do
  waited=$((waited + 1))
  [ "$waited" -lt "$TIMEOUT" ] || { echo "FAIL: postgres not ready" >&2; exit 1; }
  sleep 1
done

docker run --rm --network "$ID" \
  -e DATABASE_OWNER_URL="postgres://postgres:$OWNER_PW@$ID-db:5432/postgres" \
  -e APP_DB_PASSWORD="$APP_PW" "$IMAGE" migrate

# A household without categories: the worker's startup backfill must seed it.
docker exec "$ID-db" psql -U postgres -v ON_ERROR_STOP=1 -q -c \
  "insert into organization (id, name, slug, created_at) values ('smoke-household', 'Smoke', 'smoke', now())"

APP_URL="postgres://pfm_app:$APP_PW@$ID-db:5432/postgres"
docker run -d --name "$ID-worker" --network "$ID" -p 127.0.0.1::8081 --read-only --tmpfs /tmp \
  -e DATABASE_URL="$APP_URL" -e ENCRYPTION_KEY="$ENC_KEY" "$IMAGE" worker >/dev/null
docker run -d --name "$ID-web" --network "$ID" -p 127.0.0.1::3000 --read-only --tmpfs /tmp \
  -e DATABASE_URL="$APP_URL" -e ENCRYPTION_KEY="$ENC_KEY" \
  -e BETTER_AUTH_SECRET="$AUTH_SECRET" \
  -e BETTER_AUTH_URL=http://localhost:3000 -e APP_URL=http://localhost:3000 \
  -e SETUP_TOKEN="$SETUP_TOKEN" "$IMAGE" web >/dev/null

worker_port="$(docker port "$ID-worker" 8081/tcp | head -n1 | sed 's/.*://')"
web_port="$(docker port "$ID-web" 3000/tcp | head -n1 | sed 's/.*://')"
wait_http worker "http://127.0.0.1:$worker_port/healthz"
wait_http web "http://127.0.0.1:$web_port/api/health"

# Generated brand images: 200 and the right content type (PNG cards, ICO favicon).
check_image() {
  path="$1"; want="$2"
  out="$(curl -s --max-time 20 -o /dev/null -w '%{http_code} %{content_type}' "http://127.0.0.1:$web_port$path" || true)"
  case "$out" in
    "200 $want"*) echo "ok: web $path -> $out" ;;
    *) echo "FAIL: web $path returned '$out', expected 200 $want" >&2; dump_logs; exit 1 ;;
  esac
}
check_image /og image/png
check_image /og/twitter image/png
check_image /favicon.ico image/x-icon

# The backfill runs after the health server starts, so allow it a moment to finish.
waited=0
until docker logs "$ID-worker" 2>&1 | grep -q 'seeded default categories for 1 household'; do
  waited=$((waited + 2))
  if [ "$waited" -ge "$TIMEOUT" ]; then
    echo "FAIL: worker did not log the startup backfill" >&2
    dump_logs
    exit 1
  fi
  sleep 2
done
echo "--- worker log"
docker logs "$ID-worker" 2>&1
echo "image smoke test passed"
