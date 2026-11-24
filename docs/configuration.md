# Configuration

Arfolio is configured in two places:

1. **Environment variables** for what the server needs to start: database, secrets, public URL. These live in `.env` (Docker Compose) or in the chart's Secrets (Helm).
2. **Settings > Services** in the app for the outside services: AI, bank connections and email. Only a household **owner** sees this page.

The Services page is the easy way. Environment variables for the same settings exist for people who manage everything as code, and they win.

## Precedence

For every setting on the Services page the value is chosen in this order:

1. the **environment variable**, if it is set and not empty;
2. the value **saved from the Services page** (stored in the database, secrets encrypted);
3. the **default**, where there is one.

A setting controlled by an environment variable shows **Set by environment** on the Services page and cannot be changed there: edit the server's environment and restart. If you later remove the variable, the value saved from the page (if any) applies again.

## The Services page

Open **Settings > Services** as a household owner. Everything on it applies to the whole installation, not one household.

| Section           | Fields                                                                                                          | Environment variables                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| AI                | Anthropic API key, model for categories, model for reports, model for the advisor, model for valuations, model for statement import; **Test API key** | `ANTHROPIC_API_KEY`, `AI_CATEGORISATION_MODEL`, `AI_REPORT_MODEL`, `AI_ADVISOR_MODEL`, `AI_VALUATION_MODEL`, `AI_IMPORT_MODEL` |
| Valuation portals | Websites the AI may search per kind of asset (property, vehicles, other items), one host per line, 20 at most   | none (page only)                                                              |
| Bank connections  | The redirect URL to register, Application ID, private key, API address; **Test bank connection**                | `ENABLE_BANKING_APP_ID`, `ENABLE_BANKING_PRIVATE_KEY`, `ENABLE_BANKING_API_URL` |
| Email             | SMTP address (`smtp://` or `smtps://`, no query string), sender; **Send test email**                            | `SMTP_URL`, `MAIL_FROM`                                                       |

Behaviour worth knowing:

- **Secrets are write-only.** A saved API key, private key or SMTP address is never shown again, never sent back to the browser, and never written to logs or the audit log (which records only which setting changed). You can only replace or remove it.
- **Fresh sign-in.** Changing these settings requires that you signed in within the last 10 minutes. If the page says so, sign out and in again, then retry.
- **When changes take effect.** Saving applies at once for the web app; the worker picks the change up within about a minute. Environment variables are read at start-up, so restart after changing them.
- **Defaults.** Models default to `claude-haiku-5-5` (categories), `claude-opus-5-5` (reports), `claude-opus-5-5` (the advisor), `claude-opus-5-5` (valuations) and `claude-opus-5-5` (statement import). The Enable Banking API address defaults to `https://api.enablebanking.com`. The portal lists default to the Portuguese listing sites (see [AI features](ai.md)).
- **Invalid or unreadable values.** A saved value that no longer validates is ignored and the page asks you to enter it again. A saved value that cannot be decrypted (the `ENCRYPTION_KEY` changed) is treated as not set and shown as unreadable: enter it again to replace it.

### The encryption key

Everything saved from the Services page is stored encrypted, and so are bank sessions and Trading 212 keys. The key is `ENCRYPTION_KEY` (AES-256-GCM). **Back it up together with your database backups.** If it is lost or replaced:

- every stored value becomes unreadable: re-enter the settings on the Services page, renew each bank connection and paste each Trading 212 key again;
- your accounts, transactions and everything already imported are not affected, and a connection that cannot be read fails with a clear message instead of corrupting data;
- the generated Web Push key pair becomes unreadable too, so push sending fails until you delete the stored pair or set your own `VAPID_*` keys. A new pair means every device must turn push on again.

There is no key rotation. Details and the recovery steps are in [Backup and upgrade](backup-and-upgrade.md).

## Environment variables

### Bootstrap (required)

| Variable             | Used by              | Meaning                                                                                                                         |
| -------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`  | compose: db, migrate | Password of the PostgreSQL owner. Compose only; the Helm chart generates its own.                                                |
| `APP_DB_PASSWORD`    | compose: migrate     | Password of the unprivileged `pfm_app` role that web and worker use (`migrate` sets it). Compose only.                           |
| `BETTER_AUTH_SECRET` | web                  | At least 32 characters; signs sessions and encrypts 2FA secrets, backup codes and MCP signing keys. Back it up like `ENCRYPTION_KEY`; changing it invalidates 2FA enrolments, backup codes and MCP OAuth signing keys.                                                         |
| `ENCRYPTION_KEY`     | web, worker          | 64 hex characters (`openssl rand -hex 32`). See above.                                                                           |
| `SETUP_TOKEN`        | web                  | At least 24 characters; entered once at `/setup` to create the first account.                                                    |
| `APP_URL`            | web, worker          | Public URL, for example `https://arfolio.example.com`. Behind a proxy it must be the public https address.                       |
| `BETTER_AUTH_URL`    | web                  | The same public URL (compose defaults it to `APP_URL`).                                                                          |
| `DATABASE_URL`       | web, worker          | Connection string of the `pfm_app` role. Compose builds it for you; set it yourself only outside compose and Helm.               |

`ENCRYPTION_KEY`, `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `APP_URL` and `SETUP_TOKEN` are environment-only: they are never on the Services page.

`scripts/init-env.sh` generates all the secrets above (except the URLs) into `.env`.

### Compose-only knobs

| Variable          | Default     | Meaning                                                   |
| ----------------- | ----------- | --------------------------------------------------------- |
| `ARFOLIO_VERSION` | `latest`    | Image tag to run. Pin a release (for example `0.1.0`).    |
| `ARFOLIO_BIND`    | `127.0.0.1` | Address the web port is published on.                     |
| `ARFOLIO_PORT`    | `3000`      | Host port of the web app.                                 |

### Optional: look and behaviour

These are read by the web app (and `TZ` by the worker). With Compose, set them in `.env` (they are commented in `.env.example`). In Helm they are chart values (`app.*`).

| Variable                | Default       | Meaning                                                                                                 |
| ----------------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `BRAND_NAME`            | `Arfolio`     | Product name: UI wordmark, page titles, manifest, social cards, and the name the AI advisor writes under (the worker reads it too).                                         |
| `BRAND_PRIMARY_COLOR`   | `#2F5BC2`     | Interface colour (derived per light and dark mode) and the tile colour of every icon.                   |
| `BRAND_LOGO_URL`        | unset         | Replaces the mark in the UI (sign-in, setup, sidebar). Needs an origin your CSP allows.                 |
| `DEFAULT_LOCALE`        | `en`          | Language before a person picks theirs: `en`, `pt-PT`, `es-ES`, `fr-FR` or `it-IT`.                                          |
| `CLIENT_IP_HEADER`      | `x-real-ip`   | Header your reverse proxy sets to the real client address (used for sign-in throttling).                |
| `TZ` (worker)           | `UTC`         | Time zone of the worker's schedules (daily sync, monthly jobs). Helm: `app.timezone`.                    |
| `WORKER_HEALTH_PORT`    | `8081`        | Port of the worker's `/healthz`.                                                                          |

Branding details: the favicon, Apple touch icon, PWA icons, notification badge and the social cards are generated at runtime from the name and colour with one shared glyph. `BRAND_LOGO_URL` deliberately does not drive them (the server never fetches a remote image to render an icon). To serve your own icons, route `/icon.svg`, `/favicon.ico`, `/icons/*` and `/og*` to your files in the reverse proxy. Very light brand colours make the favicon edge faint on light browser tabs; pick one with at least 3:1 contrast against white if the tab icon matters. The "Arfolio" name and logo are not licensed for forks: see [TRADEMARK.md](../TRADEMARK.md).

### Optional: environment-only integration settings

These have no field on the Services page.

| Variable                    | Default        | Meaning                                                                                                                                          |
| --------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MERCHANT_LOGOS`            | `on`           | `on` lets the worker fetch each merchant's favicon through Google's favicon service (it learns the merchant's domain, not your transactions). `off` disables it. |
| `ADVISOR_LEARNING_MONTHS`   | `3`            | Months of history the AI advisor needs before it proposes anything (1-24). |
| `ADVISOR_WEEKLY_CAP`        | `2`            | Proactive advisor messages per member and week (0-14); a member can set their own. The welcome and the "what I learned" message do not count. `0` turns the rest off. |
| `ADVISOR_DAILY_MESSAGES`    | `50`           | Chat messages one member may send to the advisor per day (1-1000).         |
| `ADVISOR_MAX_TOOL_CALLS`    | `8`            | Tool calls the advisor may make while answering one message (1-20).        |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | generated | Web Push key pair. When unset the app generates one on first use and stores it (private key encrypted). Set **both** or neither: one alone is a startup error. Generate with `npx web-push generate-vapid-keys`. |
| `VAPID_SUBJECT`             | https `APP_URL`, else `mailto:no-reply@localhost` | `mailto:` or `https:` contact given to push services.                                                  |
| `PUSH_ALLOWED_HOSTS`        | unset          | Extra push-service host suffixes, comma separated, for self-hosted push such as UnifiedPush. FCM, Mozilla, Windows and Apple are always allowed. |
| `MCP_ALLOWED_REDIRECT_URIS` | unset          | Extra exact OAuth redirect URIs for MCP clients other than claude.ai and local tools. See [Connect Claude](mcp.md).                              |

`TRADING212_API_URL` exists for tests only (it points Trading 212 at a fake broker). Leave it unset.

### Settings that are also on the Services page

`ANTHROPIC_API_KEY`, `AI_CATEGORISATION_MODEL`, `AI_REPORT_MODEL`, `AI_ADVISOR_MODEL`, `AI_VALUATION_MODEL`, `AI_IMPORT_MODEL`, `ENABLE_BANKING_APP_ID`, `ENABLE_BANKING_PRIVATE_KEY`, `ENABLE_BANKING_API_URL`, `SMTP_URL` and `MAIL_FROM` are optional. Leave them out of `.env` to manage them from the app. The compose file already passes them through when you set them. In Helm they go in the optional Secret (`<fullname>-optional`): see [Kubernetes](kubernetes.md).

### Reverse proxy timeouts

Reading a PDF statement with AI is a single request that can take up to two minutes. If your reverse proxy closes responses sooner (many default to 30 or 60 seconds), long statements fail even though the server is still working. Raise the proxy's response timeout to at least two minutes for the app. Other requests are not affected. See [AI features](ai.md#statement-import-from-pdf).

## What leaves your server

Arfolio keeps your data in your own database. Outside connections are made only when you set them up:

- **Enable Banking**, when you connect a bank: see [Bank sync](bank-sync.md).
- **Anthropic**, when an owner adds an API key and a household switches AI on: see [AI features](ai.md).
- **Google's favicon service**, for merchant logos (only the merchant's domain). Turn it off with `MERCHANT_LOGOS=off`.
- **Your SMTP server**, for invitation emails, and the **browser push services** (or your own) for notifications.
