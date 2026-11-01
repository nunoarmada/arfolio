#!/bin/sh
# Creates Secret pfm-secrets with random values on first sync; later syncs only add keys that are
# missing and never modify an existing key. Values are lowercase hex so they are URL-safe inside
# connection strings (RESTIC_PASSWORD encrypts the PFM backup repository). ENCRYPTION_KEY is 32 random bytes as 64 hex chars.
set -eu

NAMESPACE=${NAMESPACE:-pfm}
SECRET=${SECRET:-pfm-secrets}
# KEYS (space separated) can be overridden: the chart drops POSTGRES_PASSWORD when an external database is used.
KEYS=${KEYS:-"POSTGRES_PASSWORD APP_DB_PASSWORD BETTER_AUTH_SECRET ENCRYPTION_KEY SETUP_TOKEN RESTIC_PASSWORD"}

rand() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }

err=$(mktemp)
if existing=$(kubectl -n "$NAMESPACE" get secret "$SECRET" -o go-template='{{range $k, $v := .data}}{{$k}}{{"\n"}}{{end}}' 2>"$err"); then
  missing=""
  for k in $KEYS; do
    printf '%s\n' "$existing" | grep -qx "$k" || missing="$missing $k"
  done
  if [ -z "$missing" ]; then
    echo "OK: $NAMESPACE/$SECRET already has every key."
    exit 0
  fi
  data=""
  for k in $missing; do
    data="$data${data:+,}\"$k\":\"$(rand)\""
  done
  kubectl -n "$NAMESPACE" patch secret "$SECRET" --type merge -p "{\"stringData\":{$data}}"
  echo "OK: added missing keys to $NAMESPACE/$SECRET:$missing"
elif grep -q 'NotFound' "$err"; then
  set --
  for k in $KEYS; do
    set -- "$@" "--from-literal=$k=$(rand)"
  done
  kubectl -n "$NAMESPACE" create secret generic "$SECRET" "$@"
  # Not in Git, so Argo CD neither tracks nor prunes it; this label only says who made it.
  kubectl -n "$NAMESPACE" label secret "$SECRET" app.kubernetes.io/managed-by=pfm-secrets-bootstrap
  echo "OK: created $NAMESPACE/$SECRET."
else
  cat "$err" >&2
  echo "ERROR: could not read $NAMESPACE/$SECRET." >&2
  exit 1
fi
