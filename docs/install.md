# Install with Docker Compose

This is the simplest way to run Arfolio on a VM or home server: one `compose.yaml` that starts PostgreSQL, a one-shot migration, the web app and the background worker. For Kubernetes see [Kubernetes (Helm)](kubernetes.md).

## What you need

- A Linux machine (a small VM is enough: the whole stack fits in about 1.2 GiB of memory) with Docker Engine and the Docker Compose plugin (`docker compose version` should work).
- `openssl`, `git` and `curl` on that machine.
- For access from outside your own machine: a domain name and a reverse proxy that terminates HTTPS (see [section 5](#5-put-it-behind-https)).

## 1. Get the files

```sh
git clone https://github.com/nunoarmada/arfolio.git
cd arfolio
```

You only need `compose.yaml`, `.env.example` and `scripts/init-env.sh`; the clone also gives you the docs.

## 2. Create your secrets

```sh
./scripts/init-env.sh
```

This writes `.env` from `.env.example` with fresh random secrets (database passwords, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SETUP_TOKEN`). It refuses to overwrite an existing `.env`.

**Back up `ENCRYPTION_KEY` now**, together with every database backup you take. It encrypts every stored bank session, Trading 212 key and API key saved from the Services page. Without it a restored database cannot read them and every connection must be authorised again. See [Backup and upgrade](backup-and-upgrade.md).

For a trial on your own computer nothing else needs editing. For a real installation set `APP_URL` and `BETTER_AUTH_URL` in `.env` to the public https address (for example `https://arfolio.example.com`) before the first start, or sign-in and bank callbacks fail.

## 3. Start it

```sh
docker compose up -d
```

This pulls `ghcr.io/nunoarmada/arfolio` (the version in `ARFOLIO_VERSION`, `latest` by default; set `ARFOLIO_VERSION=0.1.0` or newer in `.env` to pin it) and `postgres:17`. The database starts, `migrate` creates the schema and the unprivileged `pfm_app` role and exits, then `web` and `worker` start.

Building from source instead (for example before the first release is published): uncomment `build: .` in the `x-image` block of `compose.yaml`, then run:

```sh
docker compose build
docker compose up -d
```

Check that everything is healthy:

```sh
docker compose ps
curl -fsS http://127.0.0.1:3000/api/health
```

`web` and `worker` should show `healthy`, and `migrate` should have exited with code 0 (`docker compose ps -a`).

## 4. First-run setup

The first account is created on a one-time page that only works while no account exists and only with your `SETUP_TOKEN`.

```sh
grep '^SETUP_TOKEN=' .env
```

Open `http://localhost:3000/setup` (or your `APP_URL` followed by `/setup`), enter that value as the **Setup code**, then create the household (name, currency, the month the budget year starts, language, time zone) and your owner account. Next comes two-step verification, which is required for household owners: scan the QR code with an authenticator app, confirm a code and keep the recovery codes somewhere safe. The last step offers to configure services now or later. There is no public sign-up: further people join by invitation from **Settings > Members**. Without email configured the invitation link is shown so you can copy it.

The web port is published on `127.0.0.1` only. To change it set `ARFOLIO_BIND` and `ARFOLIO_PORT` in `.env`.

## 5. Put it behind HTTPS

Browsers only install the app (PWA) and bank providers only redirect back over https, so anything beyond a local trial needs a reverse proxy in front of `127.0.0.1:3000`. Caddy is the shortest way (it gets certificates by itself):

```
arfolio.example.com {
	reverse_proxy 127.0.0.1:3000 {
		header_up X-Real-IP {remote_host}
	}
}
```

nginx works the same way: `proxy_pass http://127.0.0.1:3000;` plus `proxy_set_header X-Real-IP $remote_addr;`.

Two things matter:

- `APP_URL` and `BETTER_AUTH_URL` must be exactly the public https address. After changing them run `docker compose up -d` again.
- The app reads the client address for sign-in throttling from the `X-Real-IP` header (`CLIENT_IP_HEADER` changes the name). Your proxy must **set** it itself, replacing anything the client sent, as in the examples. Do not expose port 3000 directly to the internet.

Do not redirect `/api/mcp` to another host or scheme if you want to connect claude.ai: see [Connect Claude](mcp.md).

## 6. Connect the services you want

Everything below is optional and is configured by the household owner from **Settings > Services** in the app (or with environment variables, which win):

- AI categorisation, monthly report and asset valuation: [AI features](ai.md).
- Bank connections through Enable Banking and Trading 212: [Bank sync](bank-sync.md).
- Email for invitations: **Settings > Services > Email**.

All settings are described in [Configuration](configuration.md).

## 7. Day to day

```sh
docker compose logs -f web worker     # follow the logs
docker compose stop                   # stop, keep the data
docker compose up -d                  # start again
docker compose down                   # remove the containers, keep the database volume
docker compose down -v                # remove everything, including the database. Destroys your data.
```

Look-and-behaviour settings (`BRAND_NAME`, `BRAND_PRIMARY_COLOR`, `BRAND_LOGO_URL`, `DEFAULT_LOCALE`, `CLIENT_IP_HEADER`, and `TZ` for the worker) are commented in `.env.example`: uncomment them in `.env` and run `docker compose up -d` again. For anything else you want to add to a service, a `compose.override.yaml` next to `compose.yaml` is read automatically.

To update to a new release, and for backups and restores, see [Backup and upgrade](backup-and-upgrade.md).

## Troubleshooting

| Symptom                                                  | Likely cause                                                                                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `run ./scripts/init-env.sh first` when starting          | `.env` is missing or incomplete. Run the script (it will not overwrite an existing file).                                               |
| Sign-in fails or loops behind a proxy                    | `APP_URL` / `BETTER_AUTH_URL` are not the exact public https address you browse to.                                                     |
| `/setup` says "Setup has already been completed."        | An account already exists. Sign in instead.                                                                                             |
| `web` unhealthy and the log names an environment variable | A value failed validation (for example `ENCRYPTION_KEY` must be 64 hex characters). The log lists the names, never the values.          |
| Bank connection or AI shows as not configured            | Nothing entered yet, or the stored value cannot be read: see [Configuration](configuration.md#the-services-page).                       |
