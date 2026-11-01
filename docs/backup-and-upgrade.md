# Backup, restore and upgrade

## What to back up

Two things, and they belong together:

1. **The database** (everything you entered or imported).
2. **`ENCRYPTION_KEY`**, which is _not_ in the database. Keep it with your backups, in a password manager or other safe place, away from the machine that runs Arfolio. Keep your `.env` (Compose) or the `<fullname>-secrets` Secret (Helm) too: it also holds `APP_DB_PASSWORD` and `BETTER_AUTH_SECRET`, which you must back up like `ENCRYPTION_KEY` (see below).

### Why the key matters

`ENCRYPTION_KEY` encrypts every stored bank session, every Trading 212 key, everything saved from the Services page (Anthropic key, Enable Banking credentials, SMTP address) and the generated Web Push private key. A database restored without its key keeps all your data, but none of those secrets can be read.

There is no key rotation. If the key is lost or replaced:

- Settings from the Services page show as unreadable: enter them again.
- Every bank connection and Trading 212 key becomes unreadable: renew each bank and paste each Trading 212 key again. Accounts and transactions already imported are not affected. A synced connection whose secret cannot be read fails with a clear error instead of corrupting data.
- The Web Push key pair becomes unreadable: push sending fails with a decrypt error (it never regenerates silently). To recover, delete the stored pair, then a new one is generated on next use: `docker compose exec -T db psql -U postgres -d pfm -c "delete from instance_secret where name = 'vapid'"` (with Helm, run the same statement as `pfm_owner` in the bundled database), or set your own `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. A new key pair invalidates existing push subscriptions: every device has to turn notifications on again.

`BETTER_AUTH_SECRET` needs the same care. Besides signing sessions, it encrypts the two-factor (TOTP) secrets and backup codes and the private key that signs MCP OAuth tokens. If it is lost or changed, everybody is signed out, owners can no longer pass two-factor sign-in with their authenticator or backup codes (their two-factor enrolment is invalidated), and MCP connectors have to be authorised again.

## Docker Compose

### Back up

```sh
docker compose exec -T db pg_dump -U postgres -d pfm --format=custom > arfolio-$(date +%F).dump
```

`--format=custom` is compressed and restores with `pg_restore`. Copy the file off the machine (restic, rclone, `scp`...) and keep it next to the saved `ENCRYPTION_KEY`. To run it nightly, put the command in a cron job (use absolute paths and `cd` into the folder that holds `compose.yaml`).

### Restore

On the same machine or a new one, with the original `.env` in place (same `ENCRYPTION_KEY`, same passwords). On a machine that already runs Arfolio, stop the app first with `docker compose stop web worker`.

```sh
docker compose up -d db
docker compose run --rm migrate
docker compose exec -T db psql -U postgres -d postgres -c 'drop database pfm' -c 'create database pfm'
docker compose exec -T db pg_restore -U postgres -d pfm --no-owner < arfolio-2026-11-01.dump
docker compose up -d
```

`migrate` creates the `pfm_app` role and its password (roles live outside the database and are not in the dump); the empty database you then create is filled by `pg_restore`, whose permissions refer to that role. This replaces everything in the database with the backup. Restore into the same or a newer Arfolio version than the one that made the dump, never an older one. Try a restore once before you need it.

## Kubernetes

With `backup.enabled: true` the chart runs a nightly `pg_dump` and sends it to S3-compatible storage with restic (see [Kubernetes](kubernetes.md#backups)). To restore: fetch `pfm.dump` with `restic restore latest --host pfm --tag pfm --target <dir>`, deploy the chart so the migrate Job has created the roles, scale web and worker to zero, recreate the `pfm` database empty and load the dump into it with `pg_restore --no-owner -U pfm_owner -d pfm`. Read the `ENCRYPTION_KEY` of a running release with:

```sh
kubectl -n <namespace> get secret <fullname>-secrets -o jsonpath='{.data.ENCRYPTION_KEY}' | base64 -d; echo
```

and store it somewhere safe now. Do the same for `BETTER_AUTH_SECRET`:

```sh
kubectl -n <namespace> get secret <fullname>-secrets -o jsonpath='{.data.BETTER_AUTH_SECRET}' | base64 -d; echo
```

Restoring a database into a release with a different `ENCRYPTION_KEY` or `BETTER_AUTH_SECRET` brings you to the situation described above.

## Upgrading

Releases follow [semantic versioning](https://semver.org); the [changelog](../CHANGELOG.md) lists what changed. Database migrations run automatically on start-up and are only ever forwards, so **take a backup before you upgrade** and do not run an older version against a newer database.

**Docker Compose.** Pin a version in `.env` (`ARFOLIO_VERSION=0.2.0`), then:

```sh
docker compose pull
docker compose up -d
```

The `migrate` service runs first; `web` and `worker` start when it succeeds. If you build from source, `git pull` and `docker compose up -d --build` instead.

**An `SMTP_URL` with a query string** (for example `smtp://host?secure=true`) is no longer accepted: it is ignored, and the app logs that once. Remove the query part before upgrading, otherwise no email is sent.

**Helm.** Update your checkout of the repository (the chart version and default image tag move together), then `helm upgrade <release> ./deploy/helm/arfolio --namespace <namespace> -f values.yaml`. The migrate Job runs as a hook before the new pods roll out.

## Upgrading from a pre-release install (chart `pfm`)

Before the first public release the Helm chart was called `pfm` and the app had another visible name. Installations made from that chart upgrade in place and keep their data. Docker Compose is new in Arfolio, so Compose users have nothing to migrate.

What stays the same, on purpose: the database name `pfm`, the roles `pfm_owner` and `pfm_app`, the migration history, cookie names, the personal access token prefix (`pfm_pat_`) and scopes, stored sessions and push subscriptions. Nobody is signed out, no token has to be recreated and no device has to re-subscribe to push.

What you do:

1. **Back up** the database and `ENCRYPTION_KEY` (above).
2. Pin the name prefix in your values so every resource keeps its name. Set `fullnameOverride` to the prefix your current resources use: check with `kubectl get sts,pvc -n <namespace>` (for example `pfm-postgres` means `pfm`). Without it the chart would build `pfm-arfolio-*` names and fail on the immutable StatefulSet selector. A wrong value is worse: the release starts on a new, empty database, while the old PersistentVolumeClaim stays untouched (nothing is deleted, so you can fix the value and upgrade again).

   ```yaml
   fullnameOverride: pfm
   app:
     brandName: Prumo # optional: keep your current visible name (the default is now Arfolio)
   ```

   Before the real upgrade, compare what would change: `helm template pfm ./deploy/helm/arfolio --namespace pfm -f values.yaml | kubectl diff -n pfm -f -` (or `helm diff upgrade` if you have the plugin). Every existing resource should show as modified, none as new under a different name.

3. Keep your existing Secrets (`pfm-secrets`, `pfm-optional`, or whatever names you set with `secrets.existingSecret` and `optionalSecret.name`). The bootstrap Job never overwrites keys that exist.
4. Use the image `ghcr.io/nunoarmada/arfolio` (the chart default) at a tag of your choice from that repository, then upgrade:

   ```sh
   helm upgrade pfm ./deploy/helm/arfolio --namespace pfm -f values.yaml
   ```

Settings you had in the optional Secret keep working. You can now also manage the AI, Enable Banking and email settings from **Settings > Services**; the environment variables still win, and the page then shows them as set by the environment. Fresh Helm installs do not need the override: `helm install arfolio ...` creates `arfolio-*` names.
