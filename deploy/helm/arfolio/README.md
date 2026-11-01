# Arfolio Helm chart

Generic chart for Arfolio, a white-label household finance app: web, worker, a migrate Job, optional bundled
PostgreSQL, optional backups, Ingress and NetworkPolicy. Defaults are neutral; set `app.url` and your own overrides.

```sh
helm install arfolio ./deploy/helm/arfolio --namespace arfolio --create-namespace \
  --set app.url=https://arfolio.example.com
```

Then read the notes Helm prints (how to get the first-run `SETUP_TOKEN`).

## How it fits together

| Piece      | What it does                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| web        | Deployment + Service on port 3000, health `/api/health`.                                                                                     |
| worker     | Deployment, health on port 8081 `/healthz`.                                                                                                  |
| migrate    | Job run as a hook before web and worker roll out (also creates the app DB role).                                                             |
| secrets    | `secrets.generate: true` (default) runs a bootstrap Job that creates `<fullname>-secrets` with random hex values and never overwrites a key. |
| postgresql | Optional bundled StatefulSet (`postgresql.enabled`), data PVC kept on uninstall. Or use `externalDatabase`.                                  |
| backup     | Optional CronJob (`backup.enabled`): `pg_dump` then restic to S3-compatible storage.                                                         |

Containers run as uid 1001 with a read-only root filesystem and a writable `/tmp` emptyDir.

### Hooks: Helm and Argo CD

The migrate Job and the secrets bootstrap carry both Helm hook annotations and Argo CD ones
(`argocd.argoproj.io/hook: Sync` with sync waves: bootstrap -3, Postgres -2, migrate `migrate.argoSyncWave` = -1,
workloads 0). Argo CD uses its own annotations when both are present.

- Helm with an external database: migrate runs as `pre-install,pre-upgrade`.
- Helm with the bundled Postgres: migrate runs as `post-install,pre-upgrade`, because the database does not exist
  yet during `pre-install`. Do not use `--wait` on the very first install.
- Argo CD: waves order everything (Postgres before migrate before web), so no special handling is needed.

## Uninstall and reinstall

The bundled Postgres data PVC is annotated `helm.sh/resource-policy: keep`, so `helm uninstall` leaves it behind.
To reinstall on the same data, point the new release at it with `postgresql.persistence.existingClaim: <fullname>-postgres`
(otherwise a fresh PVC with the same name would clash). Delete the PVC yourself to discard the data.

The bootstrap RBAC, ConfigMap and Job are Helm hooks (hook-delete-policy `before-hook-creation`), so Helm does not
remove them on uninstall; delete them by hand if you want a clean namespace
(`<fullname>-secrets-bootstrap`). The generated Secret is never owned by Helm either and also stays.

## Secrets

With `secrets.generate: true` nothing is required. To manage the Secret yourself set `secrets.existingSecret`
(and `secrets.generate: false`) with these keys:

`POSTGRES_PASSWORD` (database owner), `APP_DB_PASSWORD` (app role), `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`
(64 hex characters), `SETUP_TOKEN`, and `RESTIC_PASSWORD` if backups are on. With an external database the
owner password is not part of this Secret: it comes from `externalDatabase.existingSecret` (required), and the
bootstrap Job does not generate `POSTGRES_PASSWORD`.

The passwords are placed inside connection URLs without encoding, so they must be URL-safe (hex is ideal).

Optional settings live in a separate Secret (`optionalSecret.name`, default `<fullname>-optional`), read with
`optional: true`: `SMTP_URL`, `MAIL_FROM`, `ANTHROPIC_API_KEY`, `ENABLE_BANKING_APP_ID`,
`ENABLE_BANKING_PRIVATE_KEY`, `ENABLE_BANKING_API_URL`, `AI_CATEGORISATION_MODEL`, `AI_REPORT_MODEL`, `AI_VALUATION_MODEL`,
`MERCHANT_LOGOS` (`on` by default, `off` stops the worker fetching merchant favicons from Google's favicon service), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `PUSH_ALLOWED_HOSTS`, `MCP_ALLOWED_REDIRECT_URIS` (web and worker), and
`BACKUP_PING_URL` (backup). Use `extraEnv` / `extraEnvFrom` for anything else.

Bank connections (Enable Banking), AI and email can also be set from **Settings > Services** in the app (an
environment value wins over the page); the step-by-step guides are
[`docs/bank-sync.md`](../../../docs/bank-sync.md) and [`docs/ai.md`](../../../docs/ai.md), and the walk-through
for this chart is [`docs/kubernetes.md`](../../../docs/kubernetes.md).

### ENCRYPTION_KEY and BETTER_AUTH_SECRET: keep them, and know what rotating them means

`BETTER_AUTH_SECRET` needs the same care: besides signing sessions it encrypts two-factor secrets and backup codes and
the MCP OAuth signing key. Back it up like `ENCRYPTION_KEY`; changing it invalidates 2FA enrolments, backup codes and
MCP OAuth signing keys.

`ENCRYPTION_KEY` encrypts the stored connection secrets (bank session ids and Trading 212 keys). It is not
part of a database backup, so **back it up together with your database backups**: a restored database
without its key keeps every connection but cannot read any of their secrets.

There is no key rotation: if the key is lost or replaced, every bank connection and Trading 212 key becomes
unreadable and **all connections must be re-authorised** (renew each bank, paste each Trading 212 key again).
Transactions and accounts already imported are not affected. A synced connection whose secret cannot be read
fails with a clear error instead of corrupting data.

The generated Web Push (VAPID) private key is encrypted with the same key. A replaced key makes it unreadable:
push sending then fails with a decrypt error (it never regenerates silently). To recover, delete the stored
pair (`delete from instance_secret where name = 'vapid'`) so a new one is generated, or set `VAPID_PUBLIC_KEY`
and `VAPID_PRIVATE_KEY`. A new key pair invalidates existing push subscriptions: **every device must
re-subscribe** in the notification settings. `PUSH_ALLOWED_HOSTS` adds host suffixes of a self-hosted push
service to the built-in browser push services (FCM, Mozilla, Windows, Apple).

## Backups

Set `backup.enabled: true` and `backup.existingSecret` to a Secret with `RESTIC_REPOSITORY`, `AWS_ACCESS_KEY_ID`
and `AWS_SECRET_ACCESS_KEY`. `RESTIC_PASSWORD` comes from the Arfolio secret, or from the backup secret with
`backup.resticPasswordFromBackupSecret: true`. `backup.repositorySuffix` is appended to `RESTIC_REPOSITORY`.
Snapshots are scoped with `--host pfm --tag pfm`.

## Values

| Key                                                            | Default                                      | Description                                                                                   |
| -------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `image.repository`                                             | `ghcr.io/nunoarmada/arfolio`                 | Image (one image, args `web`, `worker`, `migrate`).                                           |
| `image.tag`                                                    | `""`                                         | Defaults to the chart `appVersion`.                                                           |
| `image.pullPolicy`                                             | `IfNotPresent`                               | `Always`, `IfNotPresent` or `Never`.                                                          |
| `imagePullSecrets`                                             | `[]`                                         | Pull secrets for every pod.                                                                   |
| `nameOverride` / `fullnameOverride`                            | `""`                                         | Naming overrides.                                                                             |
| `app.url`                                                      | `""`                                         | **Required.** Public URL (`APP_URL`, `BETTER_AUTH_URL`).                                      |
| `app.brandName`                                                | `Arfolio`                                    | `BRAND_NAME`.                                                                                 |
| `app.brandPrimaryColor` / `app.brandLogoUrl`                   | `""`                                         | Set only when non-empty.                                                                      |
| `app.defaultLocale`                                            | `en`                                         | `DEFAULT_LOCALE`: `pt-PT`, `es-ES`, `fr-FR`, `it-IT` or `en`.                                 |
| `app.timezone`                                                 | `UTC`                                        | `TZ` and default backup time zone.                                                            |
| `app.clientIpHeader`                                           | `x-real-ip`                                  | Header the app trusts for the client IP.                                                      |
| `secrets.generate`                                             | `true`                                       | Create the Secret with the bootstrap Job.                                                     |
| `secrets.existingSecret`                                       | `""`                                         | Use your own Secret (required if `generate: false`).                                          |
| `secrets.bootstrap.image` / `.resources`                       | `alpine/k8s` pinned / small                  | Bootstrap Job image and resources.                                                            |
| `optionalSecret.name`                                          | `""`                                         | Defaults to `<fullname>-optional`.                                                            |
| `extraEnv` / `extraEnvFrom`                                    | `[]`                                         | Extra env for web and worker.                                                                 |
| `web.replicas`                                                 | `1`                                          |                                                                                               |
| `web.resources`                                                | 192Mi request, 384Mi limit                   |                                                                                               |
| `web.service.type` / `.port`                                   | `ClusterIP` / `3000`                         |                                                                                               |
| `worker.replicas`                                              | `1`                                          |                                                                                               |
| `worker.healthPort`                                            | `8081`                                       | `WORKER_HEALTH_PORT`.                                                                         |
| `worker.resources`                                             | 128Mi request, 256Mi limit                   |                                                                                               |
| `migrate.backoffLimit` / `.activeDeadlineSeconds`              | `3` / `900`                                  |                                                                                               |
| `migrate.argoSyncWave`                                         | `"-1"`                                       | Argo CD sync wave of the migrate hook.                                                        |
| `migrate.resources`                                            | 128Mi request, 512Mi limit                   |                                                                                               |
| `postgresql.enabled`                                           | `true`                                       | Bundled PostgreSQL. `false` requires `externalDatabase.host`.                                 |
| `postgresql.image`                                             | `postgres:17.6-alpine` pinned by digest      |                                                                                               |
| `postgresql.persistence.size`                                  | `5Gi`                                        |                                                                                               |
| `postgresql.persistence.storageClass`                          | `""`                                         | Empty uses the cluster default.                                                               |
| `postgresql.persistence.existingClaim`                         | `""`                                         | Use an existing PVC (none is created).                                                        |
| `postgresql.resources`                                         | 256Mi request, 512Mi limit                   |                                                                                               |
| `externalDatabase.host` / `.port`                              | `""` / `5432`                                | External PostgreSQL.                                                                          |
| `externalDatabase.database`                                    | `pfm`                                        |                                                                                               |
| `externalDatabase.ownerUser` / `.appUser`                      | `pfm_owner` / `pfm_app`                      | Owner runs migrations and creates the app role.                                               |
| `externalDatabase.sslmode`                                     | `""`                                         | libpq sslmode appended to the connection URLs (`?sslmode=`); empty omits it.                  |
| `externalDatabase.existingSecret`                              | `""`                                         | **Required with an external database.** Secret with the owner password.                       |
| `externalDatabase.ownerPasswordKey`                            | `POSTGRES_PASSWORD`                          | Key in that Secret.                                                                           |
| `backup.enabled`                                               | `false`                                      | Backup CronJob.                                                                               |
| `backup.existingSecret`                                        | `""`                                         | **Required when enabled.** `RESTIC_REPOSITORY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. |
| `backup.repositorySuffix`                                      | `""`                                         | Appended to `RESTIC_REPOSITORY`.                                                              |
| `backup.resticPasswordFromBackupSecret`                        | `false`                                      | Read `RESTIC_PASSWORD` from the backup Secret.                                                |
| `backup.schedule` / `.timeZone`                                | `30 3 * * *` / `""`                          | Time zone defaults to `app.timezone`.                                                         |
| `backup.retryLock`                                             | `10m`                                        | restic `--retry-lock`.                                                                        |
| `backup.keep.daily` / `.weekly` / `.monthly`                   | `14` / `8` / `12`                            | Retention.                                                                                    |
| `backup.checkReadDataSubset`                                   | `2%`                                         | restic check data subset.                                                                     |
| `backup.dumpImage` / `.resticImage`                            | pinned                                       | `postgres` and `restic/restic` images.                                                        |
| `backup.resources`                                             | small                                        | `dump` and `restic` containers.                                                               |
| `ingress.enabled`                                              | `false`                                      |                                                                                               |
| `ingress.className` / `.annotations`                           | `""` / `{}`                                  |                                                                                               |
| `ingress.hosts` / `.tls`                                       | `[]`                                         | Standard Ingress host/path and TLS lists.                                                     |
| `networkPolicy.enabled`                                        | `false`                                      | Restrict Postgres to Arfolio pods and web to the ingress controller.                          |
| `networkPolicy.ingressController.namespaceSelector`            | `kubernetes.io/metadata.name: ingress-nginx` | Namespace of your ingress controller.                                                         |
| `networkPolicy.ingressController.podSelector`                  | `{}`                                         | Narrow to the controller pods (empty: all pods in that namespace).                            |
| `podAnnotations` / `nodeSelector` / `tolerations` / `affinity` | empty                                        | Applied to every pod.                                                                         |

## Upgrading from a pre-release install (chart `pfm`)

This chart was called `pfm` before the first public release. The chart directory and name changed, the data did not: the
database name `pfm`, the roles `pfm_owner` / `pfm_app` and the backup snapshot scope (`--host pfm --tag pfm`) are kept.
To upgrade an existing release without losing the Postgres data, keep every resource name by pinning the full name,
and keep your existing Secrets. Set `fullnameOverride` to the prefix your current resources use (check with
`kubectl get sts,pvc -n <ns>`: `pfm-postgres` means `pfm`):

```yaml
# values.yaml of the existing release
fullnameOverride: pfm
app:
  brandName: Prumo # optional: keep your current visible name (the default is now Arfolio)
```

Before upgrading, compare what would change: `helm template pfm ./deploy/helm/arfolio -n pfm -f values.yaml |
kubectl diff -n pfm -f -` (or `helm diff upgrade` with the plugin). A wrong `fullnameOverride` is not an error: the
release starts on a new, empty database and the old PVC is left untouched, so fix the value and upgrade again.

```sh
helm upgrade pfm ./deploy/helm/arfolio --namespace pfm -f values.yaml
```

Why `fullnameOverride` is required: names are built from the release name unless they already contain the chart name.
With release `pfm` and chart `arfolio` the names would become `pfm-arfolio-*`, which creates a new empty PostgreSQL
volume and fails on the immutable StatefulSet selector. With the override you keep `pfm-postgres` (StatefulSet,
Service and data PVC), `pfm-web`, `pfm-worker`, `pfm-migrate`, `pfm-backup`, and the Secrets `pfm-secrets` and
`pfm-optional`. The existing Secrets are used as they are (the bootstrap Job never overwrites existing keys); if you
set `secrets.existingSecret` or `optionalSecret.name`, those keep working too. Set `image.repository` to
`ghcr.io/nunoarmada/arfolio` (the default) and pick an image tag from that repository. Cookies, stored sessions and
push subscriptions are unaffected.

Fresh installs do not need the override: `helm install arfolio ...` creates `arfolio-*` names.

## Tests

```sh
helm lint deploy/helm/arfolio --set app.url=https://arfolio.example.com
sh deploy/helm/arfolio/tests/render.test.sh            # needs helm, kubeconform and mikefarah yq v4
sh deploy/helm/arfolio/tests/secrets-bootstrap.test.sh
```
