#!/bin/sh
# Renders the chart with several value sets and asserts on the manifests, then validates them with kubeconform.
# Run: sh deploy/helm/arfolio/tests/render.test.sh   (needs helm, kubeconform and mikefarah yq v4 on PATH)
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
CHART="$HERE/.."
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
FAILS=0

check() { # check <description> <condition-exit-code>
  if [ "$2" -eq 0 ]; then echo "PASS: $1"; else echo "FAIL: $1"; FAILS=$((FAILS + 1)); fi
}
# field <file> <kind> <name> <yq expression>: first value of the expression on that object ("" when absent).
field() { yq e "select(.kind == \"$2\" and .metadata.name == \"$3\") | $4" "$1" | grep -v '^null$' | head -1; }
# env <file> <kind> <name> <env var> <valueFrom path or value>: container 0 env helpers (pod template of Deployment/Job).
tenv() { field "$1" "$2" "$3" ".spec.template.spec.containers[0].env[] | select(.name == \"$4\") | $5"; }
has() { grep -qE -- "$2" "$1"; }          # has <file> <regex>
lacks() { ! grep -qE -- "$2" "$1"; }      # lacks <file> <regex>

cat > "$WORK/external.yaml" <<'VALS'
app:
  url: https://arfolio.example.com
postgresql:
  enabled: false
externalDatabase:
  host: db.example.com
  port: 6432
  database: finance
  ownerUser: fin_owner
  appUser: fin_app
  existingSecret: my-owner-secret
  sslmode: require
secrets:
  generate: false
  existingSecret: my-secret
backup:
  enabled: true
  existingSecret: my-backup
  repositorySuffix: pfm
ingress:
  enabled: true
  className: nginx
  annotations:
    example.com/annotation: "yes"
  hosts:
    - host: arfolio.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: arfolio-tls
      hosts: [arfolio.example.com]
networkPolicy:
  enabled: true
image:
  tag: sha-abc1234
imagePullSecrets:
  - name: my-registry
VALS

# 1. app.url is required.
helm template pfm "$CHART" --set fullnameOverride=pfm > "$WORK/nourl.out" 2>&1; RC=$?
[ "$RC" -ne 0 ]; check "no app.url: render fails" $?
has "$WORK/nourl.out" 'app\.url is required'; check "no app.url: clear message" $?

# 2. Defaults + app.url.
helm lint "$CHART" --set app.url=https://arfolio.example.com > "$WORK/lint.out" 2>&1; check "defaults: helm lint passes" $?
helm template pfm "$CHART" --set fullnameOverride=pfm --namespace pfm --set app.url=https://arfolio.example.com > "$WORK/default.yaml" 2> "$WORK/default.err"; check "defaults: renders" $?
D="$WORK/default.yaml"
has "$D" '^kind: Deployment'; check "defaults: Deployment present" $?
has "$D" 'name: pfm-web$'; check "defaults: web named after release" $?
has "$D" 'name: pfm-worker$'; check "defaults: worker present" $?
has "$D" '^kind: StatefulSet'; check "defaults: bundled Postgres StatefulSet" $?
has "$D" 'image: ghcr.io/nunoarmada/arfolio:0.1.0'; check "defaults: image tag falls back to appVersion" $?
has "$D" 'postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94'; check "defaults: Postgres image pinned by digest" $?
has "$D" 'helm.sh/hook: post-install,pre-upgrade'; check "defaults: migrate helm hook (bundled DB: after install)" $?
has "$D" 'argocd.argoproj.io/hook: Sync'; check "defaults: migrate Argo hook" $?
has "$D" 'helm.sh/resource-policy: keep'; check "defaults: data PVC kept on uninstall" $?
has "$D" 'name: TZ' && has "$D" 'value: "?UTC"?$'; check "defaults: timezone UTC" $?
has "$D" 'value: "?en"?$'; check "defaults: locale en" $?
has "$D" 'value: "?x-real-ip"?$'; check "defaults: client IP header" $?
has "$D" "name: pfm-secrets$"; check "defaults: generated secret name" $?
has "$D" 'name: pfm-secrets-bootstrap'; check "defaults: bootstrap job + RBAC" $?
has "$D" 'optional: true'; check "defaults: optional secret keys are optional" $?
for app in pfm-web pfm-worker; do
  for k in ENABLE_BANKING_APP_ID ENABLE_BANKING_PRIVATE_KEY ENABLE_BANKING_API_URL ANTHROPIC_API_KEY AI_CATEGORISATION_MODEL AI_REPORT_MODEL AI_VALUATION_MODEL MERCHANT_LOGOS VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY VAPID_SUBJECT PUSH_ALLOWED_HOSTS MCP_ALLOWED_REDIRECT_URIS; do
    [ "$(tenv "$D" Deployment "$app" "$k" .valueFrom.secretKeyRef.optional)" = "true" ]; check "defaults: $app reads optional $k from the optional secret" $?
  done
  [ "$(tenv "$D" Deployment "$app" ENCRYPTION_KEY .valueFrom.secretKeyRef.optional)" = "" ]; check "defaults: $app requires ENCRYPTION_KEY" $?
done
lacks "$D" '^kind: (Ingress|NetworkPolicy|CronJob)'; check "defaults: no Ingress/NetworkPolicy/CronJob" $?
lacks "$D" 'automountServiceAccountToken: true'; check "defaults: no SA token mounted" $?
helm template pfm "$CHART" --set fullnameOverride=pfm --set app.url=https://arfolio.example.com --set postgresql.persistence.existingClaim=my-claim > "$WORK/claim.yaml" 2>&1
lacks "$WORK/claim.yaml" '^kind: PersistentVolumeClaim'; check "existingClaim: no PVC rendered" $?
has "$WORK/claim.yaml" 'claimName: my-claim'; check "existingClaim: used by StatefulSet" $?

# 3. External DB + existing secrets + backup + ingress + network policy.
helm template pfm "$CHART" --set fullnameOverride=pfm --namespace pfm -f "$WORK/external.yaml" > "$WORK/ext.yaml" 2> "$WORK/ext.err"; check "external: renders" $?
E="$WORK/ext.yaml"
lacks "$E" '^kind: StatefulSet'; check "external: no bundled Postgres" $?
lacks "$E" 'name: pfm-secrets-bootstrap'; check "external: no bootstrap job" $?
has "$E" 'helm.sh/hook: pre-install,pre-upgrade'; check "external: migrate helm hook runs before install" $?
has "$E" 'db.example.com:6432/finance'; check "external: DATABASE_URL uses external host/port/database" $?
has "$E" 'postgres://fin_app:'; check "external: app user in DATABASE_URL" $?
has "$E" 'postgres://fin_owner:'; check "external: owner user in DATABASE_OWNER_URL" $?
has "$E" 'name: my-secret$'; check "external: existing secret referenced" $?
lacks "$E" 'name: pfm-secrets$'; check "external: generated secret not referenced" $?
has "$E" '^kind: CronJob'; check "external: backup CronJob" $?
has "$E" 'name: my-backup,'; check "external: backup secret referenced" $?
has "$E" '^kind: Ingress'; check "external: Ingress" $?
has "$E" 'ingressClassName: "?nginx"?$'; check "external: ingress class" $?
has "$E" 'example.com/annotation: "yes"'; check "external: ingress annotations" $?
has "$E" '^kind: NetworkPolicy'; check "external: NetworkPolicy" $?
lacks "$E" 'name: pfm-postgres'; check "external: no Postgres objects or policy" $?
has "$E" 'image: ghcr.io/nunoarmada/arfolio:sha-abc1234'; check "external: image tag override" $?
has "$E" 'name: my-registry$'; check "external: imagePullSecrets" $?
has "$E" 'db.example.com'; check "external: migrate waits on external host" $?

# 3b. Structure (parsed with yq, not grep).
yq --version 2>&1 | grep -q mikefarah || { echo "FAIL: mikefarah yq v4 is required on PATH (preinstalled on GitHub runners; go install github.com/mikefarah/yq/v4@latest)"; FAILS=$((FAILS + 1)); }
[ "$(field "$D" Job pfm-migrate '.metadata.annotations["argocd.argoproj.io/sync-wave"]')" = "-1" ]; check "waves: migrate -1" $?
[ "$(field "$D" StatefulSet pfm-postgres '.metadata.annotations["argocd.argoproj.io/sync-wave"]')" = "-2" ]; check "waves: postgres -2 (before migrate)" $?
[ "$(field "$D" Deployment pfm-web '.metadata.annotations["argocd.argoproj.io/sync-wave"]')" = "" ]; check "waves: web has no wave (0, after migrate)" $?
[ "$(field "$D" Job pfm-secrets-bootstrap '.metadata.annotations["argocd.argoproj.io/sync-wave"]')" = "-3" ]; check "waves: bootstrap Job -3" $?
for k in ServiceAccount Role RoleBinding ConfigMap; do
  [ "$(field "$D" $k pfm-secrets-bootstrap '.metadata.annotations["argocd.argoproj.io/sync-wave"]')" = "-4" ]; check "waves: bootstrap $k -4" $?
done
[ "$(field "$D" Job pfm-migrate '.metadata.annotations["helm.sh/hook"]')" = "post-install,pre-upgrade" ]; check "hooks: bundled Postgres -> post-install,pre-upgrade" $?
[ "$(field "$D" Job pfm-secrets-bootstrap '.metadata.annotations["helm.sh/hook"]')" = "pre-install,pre-upgrade" ]; check "hooks: bootstrap runs before install" $?
[ "$(field "$D" Role pfm-secrets-bootstrap '.rules[0].verbs | join(",")')" = "create" ] && [ "$(field "$D" Role pfm-secrets-bootstrap '.rules[0].resourceNames')" = "" ]; check "rbac: create rule is the only unnamed rule" $?
[ "$(field "$D" Role pfm-secrets-bootstrap '.rules[1].resourceNames[0]')" = "pfm-secrets" ] && [ "$(field "$D" Role pfm-secrets-bootstrap '.rules[1].verbs | join(",")')" = "get,patch" ]; check "rbac: get/patch limited to the one Secret" $?
[ "$(field "$D" Role pfm-secrets-bootstrap '.rules | length')" = "2" ]; check "rbac: exactly two rules" $?
[ "$(tenv "$D" Job pfm-secrets-bootstrap KEYS .value)" = "" ]; check "bootstrap: bundled DB generates the default key set (no KEYS override)" $?
[ "$(tenv "$D" Deployment pfm-web DEFAULT_LOCALE .value)" = "en" ]; check "env: web DEFAULT_LOCALE=en" $?
[ "$(tenv "$D" Deployment pfm-web TZ .value)" = "UTC" ]; check "env: web TZ=UTC" $?
[ "$(tenv "$D" Deployment pfm-worker TZ .value)" = "UTC" ]; check "env: worker TZ=UTC" $?
[ "$(tenv "$D" Deployment pfm-web CLIENT_IP_HEADER .value)" = "x-real-ip" ]; check "env: web CLIENT_IP_HEADER=x-real-ip" $?
[ "$(tenv "$D" Deployment pfm-web APP_URL .value)" = "https://arfolio.example.com" ]; check "env: web APP_URL from app.url" $?
[ "$(tenv "$D" Deployment pfm-worker APP_URL .value)" = "https://arfolio.example.com" ]; check "env: worker APP_URL from app.url (VAPID subject)" $?
for d in web worker; do
  [ "$(field "$D" Deployment pfm-$d '.spec.template.spec.securityContext.runAsNonRoot')" = "true" ]; check "security: $d runAsNonRoot" $?
  [ "$(field "$D" Deployment pfm-$d '.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem')" = "true" ]; check "security: $d readOnlyRootFilesystem" $?
  [ "$(field "$D" Deployment pfm-$d '.spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation')" = "false" ]; check "security: $d no privilege escalation" $?
  [ "$(field "$D" Deployment pfm-$d '.spec.template.spec.containers[0].volumeMounts[0].mountPath')" = "/tmp" ]; check "security: $d writable /tmp mount" $?
done

[ "$(field "$E" Job pfm-migrate '.metadata.annotations["helm.sh/hook"]')" = "pre-install,pre-upgrade" ]; check "hooks: external DB -> pre-install,pre-upgrade" $?
[ "$(field "$E" Job pfm-secrets-bootstrap '.kind')" = "" ] && [ "$(field "$E" ServiceAccount pfm-secrets-bootstrap '.kind')" = "" ]; check "bootstrap: skipped with secrets.existingSecret" $?
[ "$(tenv "$E" Job pfm-migrate POSTGRES_PASSWORD .valueFrom.secretKeyRef.name)" = "my-owner-secret" ]; check "external: owner password from externalDatabase.existingSecret" $?
[ "$(tenv "$E" Deployment pfm-web APP_DB_PASSWORD .valueFrom.secretKeyRef.name)" = "my-secret" ]; check "external: app password from secrets.existingSecret" $?
[ "$(tenv "$E" Deployment pfm-web DATABASE_URL .value)" = 'postgres://fin_app:$(APP_DB_PASSWORD)@db.example.com:6432/finance?sslmode=require' ]; check "external: DATABASE_URL incl. sslmode" $?
[ "$(tenv "$E" Job pfm-migrate DATABASE_OWNER_URL .value)" = 'postgres://fin_owner:$(POSTGRES_PASSWORD)@db.example.com:6432/finance?sslmode=require' ]; check "external: DATABASE_OWNER_URL incl. sslmode" $?
[ "$(field "$E" CronJob pfm-backup '.spec.jobTemplate.spec.template.spec.initContainers[0].env[] | select(.name == "PGPASSWORD") | .valueFrom.secretKeyRef.name')" = "my-owner-secret" ]; check "external: backup dump uses owner secret" $?
BK='.spec.jobTemplate.spec.template.spec.containers[0].env[]'
[ "$(field "$E" CronJob pfm-backup "$BK | select(.name == \"RESTIC_PASSWORD\") | .valueFrom.secretKeyRef.name")" = "my-secret" ]; check "backup: RESTIC_PASSWORD from PFM secret by default" $?
[ "$(field "$E" CronJob pfm-backup "$BK | select(.name == \"REPOSITORY_SUFFIX\") | .value")" = "pfm" ]; check "backup: repository suffix passed via env" $?
[ "$(field "$E" CronJob pfm-backup "$BK | select(.name == \"RESTIC_REPOSITORY\") | .valueFrom.secretKeyRef.name")" = "my-backup" ]; check "backup: repository from backup secret" $?
helm template pfm "$CHART" --set fullnameOverride=pfm -f "$WORK/external.yaml" --set backup.resticPasswordFromBackupSecret=true > "$WORK/ext2.yaml" 2>&1
[ "$(field "$WORK/ext2.yaml" CronJob pfm-backup "$BK | select(.name == \"RESTIC_PASSWORD\") | .valueFrom.secretKeyRef.name")" = "my-backup" ]; check "backup: RESTIC_PASSWORD from backup secret when requested" $?
# Network policies (external render has no Postgres policy; web policy only).
[ "$(field "$E" NetworkPolicy pfm-web '.spec.podSelector.matchLabels["app.kubernetes.io/name"]')" = "pfm-web" ]; check "netpol: web policy selects web pods" $?
[ "$(field "$E" NetworkPolicy pfm-web '.spec.ingress[0].from[0].namespaceSelector.matchLabels["kubernetes.io/metadata.name"]')" = "ingress-nginx" ]; check "netpol: default ingress namespace selector" $?
[ "$(field "$E" NetworkPolicy pfm-web '.spec.ingress[0].from[0].podSelector | length')" = "0" ]; check "netpol: default pod selector is empty" $?
helm template pfm "$CHART" --set fullnameOverride=pfm --set app.url=https://x --set networkPolicy.enabled=true \
  --set networkPolicy.ingressController.namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name=kube-system \
  --set networkPolicy.ingressController.podSelector.matchLabels.app\\.kubernetes\\.io/name=ingress-controller > "$WORK/np.yaml" 2>&1
[ "$(field "$WORK/np.yaml" NetworkPolicy pfm-web '.spec.ingress[0].from[0].namespaceSelector.matchLabels["kubernetes.io/metadata.name"]')" = "kube-system" ]; check "netpol: namespace selector configurable" $?
[ "$(field "$WORK/np.yaml" NetworkPolicy pfm-web '.spec.ingress[0].from[0].podSelector.matchLabels["app.kubernetes.io/name"]')" = "ingress-controller" ]; check "netpol: pod selector configurable" $?
[ "$(field "$WORK/np.yaml" NetworkPolicy pfm-postgres '.spec.ingress[0].from[0].podSelector.matchExpressions[0].values | join(",")')" = "pfm-web,pfm-worker,pfm-migrate,pfm-backup" ]; check "netpol: Postgres reachable only from PFM pods" $?
# External database with generated app secrets: no POSTGRES_PASSWORD generated.
helm template pfm "$CHART" --set fullnameOverride=pfm --set app.url=https://x --set postgresql.enabled=false --set externalDatabase.host=h --set externalDatabase.existingSecret=o > "$WORK/extgen.yaml" 2>&1
[ "$(tenv "$WORK/extgen.yaml" Job pfm-secrets-bootstrap KEYS .value)" = "APP_DB_PASSWORD BETTER_AUTH_SECRET ENCRYPTION_KEY SETUP_TOKEN RESTIC_PASSWORD" ]; check "bootstrap: external DB does not generate POSTGRES_PASSWORD" $?

# 4. Misconfiguration fails clearly.
helm template pfm "$CHART" --set fullnameOverride=pfm --set app.url=https://x --set backup.enabled=true > "$WORK/bk.out" 2>&1; RC=$?
[ "$RC" -ne 0 ] && has "$WORK/bk.out" 'backup\.existingSecret is required'; check "backup without existingSecret fails clearly" $?
helm template pfm "$CHART" --set fullnameOverride=pfm --set app.url=https://x --set postgresql.enabled=false > "$WORK/db.out" 2>&1; RC=$?
[ "$RC" -ne 0 ] && has "$WORK/db.out" 'externalDatabase\.host is required'; check "no database configured fails clearly" $?
helm template pfm "$CHART" --set fullnameOverride=pfm --set app.url=https://x --set postgresql.enabled=false --set externalDatabase.host=h > "$WORK/own.out" 2>&1; RC=$?
[ "$RC" -ne 0 ] && has "$WORK/own.out" 'externalDatabase\.existingSecret is required'; check "external DB without owner secret fails clearly" $?
helm template pfm "$CHART" --set fullnameOverride=pfm --set app.url=https://x --set secrets.generate=false > "$WORK/sec.out" 2>&1; RC=$?
[ "$RC" -ne 0 ] && has "$WORK/sec.out" 'secrets\.existingSecret is required'; check "generate=false without existingSecret fails clearly" $?
helm template pfm "$CHART" --set fullnameOverride=pfm --set app.url=https://x --set image.pullPolicy=Sometimes > "$WORK/schema.out" 2>&1; RC=$?
[ "$RC" -ne 0 ]; check "schema rejects invalid pullPolicy" $?

# 4b. Upgrade compatibility: an install named `pfm` (chart renamed from pfm to arfolio) keeps every name that
# holds state or is immutable. These names are what the pre-rename chart rendered for release `pfm`; changing any of
# them would orphan the Postgres data (new PVC) or make `helm upgrade` fail on an immutable selector.
# The chart-name-derived label app.kubernetes.io/part-of is deliberately not asserted: labels on objects and pod
# templates are mutable.
[ "$(tenv "$D" Deployment pfm-web BRAND_NAME .value)" = "Arfolio" ]; check "defaults: BRAND_NAME is Arfolio" $?
for n in pfm-postgres; do
  [ "$(field "$D" StatefulSet $n '.metadata.name')" = "$n" ]; check "compat: StatefulSet $n" $?
  [ "$(field "$D" Service $n '.metadata.name')" = "$n" ]; check "compat: Service $n" $?
  [ "$(field "$D" PersistentVolumeClaim $n '.metadata.name')" = "$n" ]; check "compat: data PVC $n" $?
done
[ "$(field "$D" StatefulSet pfm-postgres '.spec.serviceName')" = "pfm-postgres" ]; check "compat: StatefulSet serviceName pfm-postgres" $?
[ "$(field "$D" StatefulSet pfm-postgres '.spec.selector.matchLabels["app.kubernetes.io/name"]')" = "pfm-postgres" ]; check "compat: StatefulSet selector (immutable) pfm-postgres" $?
[ "$(field "$D" StatefulSet pfm-postgres '.spec.selector.matchLabels | length')" = "1" ]; check "compat: StatefulSet selector has exactly one label" $?
[ "$(field "$D" StatefulSet pfm-postgres '.spec.volumeClaimTemplates | length')" = "" ] || [ "$(field "$D" StatefulSet pfm-postgres '.spec.volumeClaimTemplates | length')" = "0" ]; check "compat: no volumeClaimTemplates (data PVC is a standalone claim)" $?
[ "$(field "$D" StatefulSet pfm-postgres '.spec.template.spec.volumes[] | select(.name == "data") | .persistentVolumeClaim.claimName')" = "pfm-postgres" ]; check "compat: StatefulSet mounts existing PVC pfm-postgres" $?
[ "$(field "$D" Service pfm-postgres '.spec.selector["app.kubernetes.io/name"]')" = "pfm-postgres" ]; check "compat: Postgres Service selector" $?
[ "$(field "$D" StatefulSet pfm-postgres '.spec.template.spec.containers[0].env[] | select(.name == "POSTGRES_DB") | .value')" = "pfm" ]; check "compat: POSTGRES_DB stays pfm" $?
[ "$(field "$D" StatefulSet pfm-postgres '.spec.template.spec.containers[0].env[] | select(.name == "POSTGRES_USER") | .value')" = "pfm_owner" ]; check "compat: POSTGRES_USER stays pfm_owner" $?
[ "$(field "$D" StatefulSet pfm-postgres '.spec.template.spec.containers[0].env[] | select(.name == "POSTGRES_PASSWORD") | .valueFrom.secretKeyRef.name')" = "pfm-secrets" ]; check "compat: Postgres password read from existing Secret pfm-secrets" $?
[ "$(tenv "$D" Deployment pfm-web APP_DB_PASSWORD .valueFrom.secretKeyRef.name)" = "pfm-secrets" ]; check "compat: web uses existing Secret pfm-secrets" $?
[ "$(tenv "$D" Deployment pfm-web DATABASE_URL .value)" = 'postgres://pfm_app:$(APP_DB_PASSWORD)@pfm-postgres:5432/pfm' ]; check "compat: DATABASE_URL (pfm_app, pfm-postgres, db pfm)" $?
[ "$(tenv "$D" Job pfm-migrate DATABASE_OWNER_URL .value)" = 'postgres://pfm_owner:$(POSTGRES_PASSWORD)@pfm-postgres:5432/pfm' ]; check "compat: DATABASE_OWNER_URL (pfm_owner, pfm-postgres, db pfm)" $?
[ "$(tenv "$D" Deployment pfm-web SETUP_TOKEN .valueFrom.secretKeyRef.name)" = "pfm-secrets" ] && [ "$(tenv "$D" Deployment pfm-worker ENCRYPTION_KEY .valueFrom.secretKeyRef.name)" = "pfm-secrets" ]; check "compat: SETUP_TOKEN/ENCRYPTION_KEY from pfm-secrets" $?
[ "$(tenv "$D" Deployment pfm-web SMTP_URL .valueFrom.secretKeyRef.name)" = "pfm-optional" ] && [ "$(tenv "$D" Deployment pfm-worker VAPID_PRIVATE_KEY .valueFrom.secretKeyRef.name)" = "pfm-optional" ]; check "compat: optional settings from existing Secret pfm-optional" $?
[ "$(field "$D" Deployment pfm-web '.spec.selector.matchLabels["app.kubernetes.io/name"]')" = "pfm-web" ]; check "compat: web selector pfm-web" $?
[ "$(field "$D" Deployment pfm-worker '.spec.selector.matchLabels["app.kubernetes.io/name"]')" = "pfm-worker" ]; check "compat: worker selector pfm-worker" $?
[ "$(field "$D" Service pfm-web '.spec.selector["app.kubernetes.io/name"]')" = "pfm-web" ]; check "compat: web Service pfm-web selects pfm-web" $?
[ "$(field "$D" Job pfm-migrate '.kind')" = "Job" ]; check "compat: migrate Job pfm-migrate" $?
[ "$(field "$E" CronJob pfm-backup '.kind')" = "CronJob" ]; check "compat: backup CronJob pfm-backup" $?
[ "$(field "$E" Ingress pfm '.kind')" = "Ingress" ] && [ "$(field "$E" Ingress pfm '.spec.rules[0].http.paths[0].backend.service.name')" = "pfm-web" ]; check "compat: Ingress pfm routes to Service pfm-web" $?
# Without the override the release name no longer contains the chart name, so the names change: this is why
# the README tells existing installs to set fullnameOverride: pfm.
helm template pfm "$CHART" --set app.url=https://arfolio.example.com > "$WORK/nooverride.yaml" 2>&1
has "$WORK/nooverride.yaml" 'name: pfm-arfolio-postgres$'; check "compat: without fullnameOverride the names change (override is required)" $?
helm template arfolio "$CHART" --set app.url=https://arfolio.example.com > "$WORK/fresh.yaml" 2>&1
has "$WORK/fresh.yaml" 'name: arfolio-web$' && lacks "$WORK/fresh.yaml" 'name: pfm-'; check "fresh install: release arfolio renders arfolio-* names" $?

# 5. Schema validity of the rendered manifests.
if command -v kubeconform >/dev/null 2>&1; then
  kubeconform -strict -ignore-missing-schemas -summary "$D" > "$WORK/kc1.out" 2>&1; check "kubeconform: defaults valid" $?
  kubeconform -strict -ignore-missing-schemas -summary "$E" > "$WORK/kc2.out" 2>&1; check "kubeconform: external valid" $?
  # Guard against a vacuous pass: kubeconform must actually have validated resources.
  grep -Eq 'Valid: [1-9]' "$WORK/kc1.out"; check "kubeconform: defaults validated at least one resource" $?
else
  echo "FAIL: kubeconform not installed"; FAILS=$((FAILS + 1))
fi

if [ "$FAILS" -ne 0 ]; then echo "$FAILS check(s) failed"; exit 1; fi
echo "all checks passed"
