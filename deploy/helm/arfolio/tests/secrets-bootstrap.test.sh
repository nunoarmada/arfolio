#!/bin/sh
# Tests deploy/helm/arfolio/scripts/secrets-bootstrap.sh against a stub kubectl that records every call.
# Run: sh deploy/helm/arfolio/tests/secrets-bootstrap.test.sh
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$HERE/../scripts/secrets-bootstrap.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
FAILS=0
ALL_KEYS="POSTGRES_PASSWORD APP_DB_PASSWORD BETTER_AUTH_SECRET ENCRYPTION_KEY SETUP_TOKEN RESTIC_PASSWORD"

# Stub kubectl. STUB_MODE: absent | present | error. STUB_KEYS: keys the existing Secret holds.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/kubectl" <<'STUB'
#!/bin/sh
echo "$*" >> "$KUBECTL_LOG"
case "$*" in
  *" get secret "*)
    case "$STUB_MODE" in
      absent) echo 'Error from server (NotFound): secrets "pfm-secrets" not found' >&2; exit 1 ;;
      error) echo 'Error from server (Forbidden): secrets is forbidden' >&2; exit 1 ;;
      present) for k in $STUB_KEYS; do echo "$k"; done; exit 0 ;;
    esac ;;
esac
exit 0
STUB
chmod +x "$WORK/bin/kubectl"

run() { # run <mode> <keys>; optional env KEYS_OVERRIDE limits the keys the script manages; sets RC, LOG
  : > "$WORK/log"
  RC=0
  PATH="$WORK/bin:$PATH" KUBECTL_LOG="$WORK/log" STUB_MODE="$1" STUB_KEYS="$2" NAMESPACE=pfm \
    env ${KEYS_OVERRIDE:+KEYS="$KEYS_OVERRIDE"} sh "$SCRIPT" > "$WORK/out" 2>&1 || RC=$?
  LOG=$(cat "$WORK/log")
}

check() { # check <description> <condition-exit-code>
  if [ "$2" -eq 0 ]; then echo "PASS: $1"; else echo "FAIL: $1"; FAILS=$((FAILS + 1)); fi
}

count() { printf '%s\n' "$LOG" | grep -c -e "$1"; }

# 1. Absent secret -> exactly one create with the 6 keys, no patch.
run absent ""
check "absent: script exits 0" "$RC"
[ "$(count ' create secret generic pfm-secrets')" -eq 1 ]; check "absent: exactly one create" $?
for k in $ALL_KEYS; do
  [ "$(count "--from-literal=$k=")" -eq 1 ]; check "absent: create carries $k" $?
done
[ "$(printf '%s\n' "$LOG" | grep -o -- '--from-literal=' | wc -l)" -eq 6 ]; check "absent: exactly 6 keys" $?
printf '%s\n' "$LOG" | grep -o -- '--from-literal=[A-Z_]*=[^ ]*' | sed 's/^--from-literal=[A-Z_]*=//' \
  | grep -qv '^[0-9a-f]\{64\}$'; [ $? -ne 0 ]; check "absent: every value is 64 lowercase hex chars" $?
[ "$(count ' patch ')" -eq 0 ]; check "absent: no patch" $?
[ "$(printf '%s\n' "$LOG" | grep ' create ' | grep -c 'pfm-secrets')" -eq 1 ] && ! printf '%s\n' "$LOG" | grep -q 'ownerReferences'; check "absent: no ownerReferences" $?

# 2. Present with all keys -> no write at all.
run present "$ALL_KEYS"
check "complete: script exits 0" "$RC"
printf '%s\n' "$LOG" | grep -Eq ' (create|patch|apply|replace|delete|label|annotate) '; [ $? -ne 0 ]; check "complete: no write call" $?

# 3. Present, missing SETUP_TOKEN -> one patch adding only that key.
run present "POSTGRES_PASSWORD APP_DB_PASSWORD BETTER_AUTH_SECRET ENCRYPTION_KEY RESTIC_PASSWORD"
check "partial: script exits 0" "$RC"
[ "$(count ' patch secret pfm-secrets')" -eq 1 ]; check "partial: exactly one patch" $?
[ "$(count ' create ')" -eq 0 ]; check "partial: no create" $?
printf '%s\n' "$LOG" | grep ' patch ' | grep -q '"SETUP_TOKEN":"[0-9a-f]\{64\}"'; check "partial: patch adds SETUP_TOKEN" $?
for k in POSTGRES_PASSWORD APP_DB_PASSWORD BETTER_AUTH_SECRET ENCRYPTION_KEY RESTIC_PASSWORD; do
  ! printf '%s\n' "$LOG" | grep ' patch ' | grep -q "$k"; check "partial: patch leaves $k untouched" $?
done

# 3b. Secret created before RESTIC_PASSWORD existed -> patch adds only RESTIC_PASSWORD.
run present "POSTGRES_PASSWORD APP_DB_PASSWORD BETTER_AUTH_SECRET ENCRYPTION_KEY SETUP_TOKEN"
check "upgrade: script exits 0" "$RC"
[ "$(count ' patch secret pfm-secrets')" -eq 1 ]; check "upgrade: exactly one patch" $?
printf '%s\n' "$LOG" | grep ' patch ' | grep -q '"RESTIC_PASSWORD":"[0-9a-f]\{64\}"'; check "upgrade: patch adds RESTIC_PASSWORD" $?
[ "$(printf '%s\n' "$LOG" | grep ' patch ' | grep -o '"[A-Z_]*":"' | wc -l)" -eq 1 ]; check "upgrade: patch carries exactly one key" $?

# 4. Unexpected kubectl error (not NotFound) -> fail, never write.
run error ""
[ "$RC" -ne 0 ]; check "error: script exits non-zero" $?
printf '%s\n' "$LOG" | grep -Eq ' (create|patch) '; [ $? -ne 0 ]; check "error: no write call" $?

# 5. External database mode: the chart sets KEYS without POSTGRES_PASSWORD -> never generated, never touched.
EXT_KEYS="APP_DB_PASSWORD BETTER_AUTH_SECRET ENCRYPTION_KEY SETUP_TOKEN RESTIC_PASSWORD"
KEYS_OVERRIDE="$EXT_KEYS" run absent ""
check "external keys: script exits 0" "$RC"
[ "$(printf '%s\n' "$LOG" | grep -o -- '--from-literal=' | wc -l)" -eq 5 ]; check "external keys: exactly 5 keys created" $?
! printf '%s\n' "$LOG" | grep -q 'POSTGRES_PASSWORD'; check "external keys: no POSTGRES_PASSWORD generated" $?
KEYS_OVERRIDE="$EXT_KEYS" run present "$EXT_KEYS"
printf '%s\n' "$LOG" | grep -Eq ' (create|patch) '; [ $? -ne 0 ]; check "external keys: complete secret needs no write (no POSTGRES_PASSWORD demanded)" $?
KEYS_OVERRIDE="$EXT_KEYS" run present "APP_DB_PASSWORD BETTER_AUTH_SECRET ENCRYPTION_KEY RESTIC_PASSWORD"
printf '%s\n' "$LOG" | grep ' patch ' | grep -q '"SETUP_TOKEN":"[0-9a-f]\{64\}"' && ! printf '%s\n' "$LOG" | grep ' patch ' | grep -q 'POSTGRES_PASSWORD'; check "external keys: patch adds only the missing key" $?

# 6. Errors are reported in English.
run error ""
grep -q '^ERROR: could not read' "$WORK/out"; check "error: message is prefixed ERROR:" $?

if [ "$FAILS" -ne 0 ]; then echo "$FAILS check(s) failed"; exit 1; fi
echo "all checks passed"
