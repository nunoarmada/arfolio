# Install on Kubernetes (Helm)

The chart in `deploy/helm/arfolio` runs Arfolio as a web Deployment, a worker Deployment and a migrate Job, with an optional bundled PostgreSQL, optional backups, an Ingress and a NetworkPolicy. It is a plain Helm chart you install from a checkout of the repository. The full list of values, hook details and chart tests are in the [chart README](../deploy/helm/arfolio/README.md); this page is the walk-through.

If you only have one machine, [Docker Compose](install.md) is simpler.

## What you need

- Kubernetes with a default StorageClass (or your own PVC) and Helm 3.
- An Ingress controller and TLS if you want access from outside the cluster. Arfolio must be served over https on a stable address: that address is `app.url`.

## 1. Install

```sh
git clone https://github.com/nunoarmada/arfolio.git
cd arfolio
helm install arfolio ./deploy/helm/arfolio --namespace arfolio --create-namespace \
  --set app.url=https://arfolio.example.com
```

`app.url` is required: it becomes `APP_URL` and `BETTER_AUTH_URL`. Do not use `--wait` on the very first install: with the bundled PostgreSQL the migrate Job runs after the database exists.

On first install a bootstrap Job creates the Secret `<fullname>-secrets` with random values for the database passwords, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY` and `SETUP_TOKEN`, and never overwrites a key that already exists. The release name `arfolio` gives resources named `arfolio-web`, `arfolio-worker` and so on.

## 2. Expose it

Create an Ingress from values, for example with ingress-nginx and cert-manager:

```yaml
app:
  url: https://arfolio.example.com
ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
  hosts:
    - host: arfolio.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: arfolio-tls
      hosts: [arfolio.example.com]
```

The app reads the client address for sign-in throttling from `x-real-ip` (`app.clientIpHeader`). Your ingress controller must **overwrite** that header with the real client address, not append to what the client sent. To try the app without an Ingress: `kubectl -n arfolio port-forward svc/arfolio-web 3000:3000` and set `app.url` to the address you browse to.

## 3. First-run setup

```sh
kubectl -n arfolio get secret arfolio-secrets -o jsonpath='{.data.SETUP_TOKEN}' | base64 -d; echo
```

Open `<app.url>/setup`, enter that value as the Setup code and create the household and the first owner (two-step verification follows). If the Secret is not found yet, wait for the bootstrap Job (`kubectl -n arfolio get jobs`).

## 4. Configure

The household owner configures AI, bank connections and email from **Settings > Services**. To manage them as code, put the variables in the optional Secret `<fullname>-optional` (read with `optional: true` by web and worker); environment values win over the page. Look and behaviour are chart values (`app.brandName`, `app.brandPrimaryColor`, `app.brandLogoUrl`, `app.defaultLocale`, `app.timezone`). Everything is listed in [Configuration](configuration.md); the chart README names which variables the optional Secret reads.

```sh
kubectl -n arfolio create secret generic arfolio-optional \
  --from-literal=ANTHROPIC_API_KEY='sk-ant-...'
kubectl -n arfolio rollout restart deployment/arfolio-web deployment/arfolio-worker
```

## Database

By default a bundled PostgreSQL StatefulSet is used (`postgresql.enabled: true`), with a data volume that is kept when you uninstall. To use your own PostgreSQL set `postgresql.enabled: false` and `externalDatabase.host`, `externalDatabase.existingSecret` (with the owner password) and, if needed, `externalDatabase.sslmode`. The migrate Job creates the `pfm_app` role the app connects as; the owner role (`pfm_owner` by default) must be allowed to create roles.

## Backups

Set `backup.enabled: true` and `backup.existingSecret` to a Secret with `RESTIC_REPOSITORY`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. A nightly CronJob dumps the database and stores it, encrypted, with restic in S3-compatible storage. Keep `RESTIC_PASSWORD` safe: without it the backups cannot be read. **Also back up `ENCRYPTION_KEY`**, which is not in the dump: see [Backup and upgrade](backup-and-upgrade.md).

## Upgrade, uninstall and migrating a pre-release install

- Upgrade: update your checkout and run `helm upgrade arfolio ./deploy/helm/arfolio -n arfolio -f values.yaml` (details in [Backup and upgrade](backup-and-upgrade.md#upgrading)).
- Uninstall: `helm uninstall` keeps the bundled database volume and the generated Secret. See the chart README for how to reinstall on the same data or clean up.
- Existing installations of the earlier `pfm` chart upgrade in place by setting `fullnameOverride` to the prefix of your current resources (see `kubectl get sts,pvc -n <ns>`) and checking `helm template` against the cluster first: see [Upgrading from a pre-release install](backup-and-upgrade.md#upgrading-from-a-pre-release-install-chart-pfm).
