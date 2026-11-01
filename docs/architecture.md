# Architecture

A short tour of how Arfolio is built, for people who run it, review it or want to contribute. It describes the design, not every file.

## Shape

Arfolio is a self-hosted web app for household finances. One container image runs in three modes (`web`, `worker`, `migrate`) next to one PostgreSQL database. There is no Redis, no message broker and no external service that has to be reachable for the app to work.

```
 browser / PWA ──https──▶ reverse proxy ──▶  web (Next.js)  ──┐
 Claude (MCP) ──────────────────────────────▶ /api/mcp        ├──▶ PostgreSQL
                                              worker (Node) ──┘     (data + job queue)
                                                  │
                      Enable Banking · Trading 212 · Anthropic · push services (only if configured)
```

## Stack

- **TypeScript monorepo** (pnpm workspaces), Node 22.
- **`apps/web`**: Next.js App Router. UI, server actions, the REST-ish route handlers, the PWA (service worker), the MCP endpoint and the OAuth endpoints.
- **`apps/worker`**: a Node process that runs the job queue. Same image as the web app, different command.
- **`packages/db`**: Drizzle ORM schema, SQL migrations, the migration runner and the database roles.
- **`packages/core`**: framework-free domain logic with unit tests: money, descriptions, deduplication, transfer matching, rules, budgets, recurring detection, net worth, environment parsing, encryption.
- **`packages/services`**: the application services every entry point uses (accounts, transactions, budgets, net worth, connections, import, AI, insights, notifications, instance settings).
- **`packages/connectors`**: the connector interface and its implementations (Enable Banking, Trading 212).
- **`packages/mcp`**: the MCP tool definitions over the services, so the web route stays thin.
- **PostgreSQL 17**, with **pg-boss** as the job queue (Postgres-backed, so nothing else to run).
- **Better Auth** for email and password sign-in, TOTP two-step verification, sessions, organisations (households) and the OAuth provider used by MCP.
- UI: Tailwind CSS, shadcn/ui components, **next-intl** for translations, Serwist for the service worker, Web Push (VAPID). AI: the Anthropic TypeScript SDK.

The web app, the worker and the MCP server all call the same services, so a rule written once (for example "transfers between your own accounts are not spending") holds everywhere.

## Money and time

Amounts are integers in minor units (cents) with an ISO currency, never floats. A household has a currency, a time zone and a fiscal-year start month; the budget year and every "this month" view follow them.

## Tenancy, roles and isolation

- A **household** is the tenant. It is a Better Auth organisation, and every domain table carries its id as `household_id`.
- Roles per household member: **owner**, **member** and **viewer**. Viewers read; members and owners write; owners also manage members and the household's settings. Installation-wide integration settings (the Services page) are editable by owners only. Owners must have two-step verification enabled before they can use the app.
- **Row-Level Security** is the second line of defence. The database has two kinds of role: the **owner** role (the Postgres superuser in Compose, `pfm_owner` in Helm) runs migrations, and the unprivileged **`pfm_app`** role is what the web app and the worker connect as. `pfm_app` cannot bypass RLS. Every request or job runs its queries in a transaction that first sets the household with a transaction-local `set_config('app.household_id', ...)`; the policies on every domain table compare against it. A query that forgets the household returns nothing instead of another household's rows.
- Better Auth and pg-boss tables carry no household column and are reached through grants. Jobs always carry the household id in their payload.

## Security model

- **Sign-in:** password hashes with Better Auth's scrypt; TOTP two-step verification with recovery codes; enabling 2FA ends the user's other sessions. Sign-in attempts are throttled in Postgres per email and client address, recorded before the password is checked. Cookies are httpOnly, secure and SameSite=Lax; mutations are CSRF-protected; secure headers (CSP, HSTS and friends) are set by the app.
- **First account:** created through the one-time `/setup` page, which works only while no account exists and only with the installation's `SETUP_TOKEN`. There is no public sign-up; further members join by invitation.
- **Secrets at rest:** bank sessions, Trading 212 keys, everything saved from the Services page and the generated push private key are encrypted with AES-256-GCM using `ENCRYPTION_KEY`. Each ciphertext is bound to its row (authenticated additional data), so a value copied to another row fails to decrypt. A stored secret is never sent to the browser and never written to logs or the audit log.
- **Audit log:** sign-ins, connection changes, token creation, settings changes (by key name only) and every write made through MCP.
- **Least privilege at the edges:** bank and broker connections are read-only; MCP credentials carry at most their owner's role; the containers run as a non-root user with a read-only root filesystem and no capabilities.

## Connectors and the sync pipeline

Every source implements one connector interface (consent, list accounts, fetch transactions and balances, positions for brokers). Enable Banking covers European banks through PSD2 consent; Trading 212 uses the broker's API with a read-only key. Statement files (CSV, XLSX, OFX) and manual entry are first-class alternatives.

A sync of one connection:

1. A scheduler queues each due connection about once a day, honouring PSD2 call limits, and a person can ask for a refresh.
2. The worker fetches from a few days before the last sync, to catch items that were booked late.
3. Rows are upserted and deduplicated: by the provider's id, otherwise by a hash of account, date, amount and normalised description. A pending row is replaced when its booked version arrives.
4. Balances are stored as daily snapshots, and drift against computed balances is flagged.
5. **Transfer matching** pairs an outflow and an inflow of the same amount between two household accounts within a few days, so moving money between your own accounts never counts as spending or income.
6. **Categorisation**, in order: your rules, then merchant memory (the category you last confirmed for that counterparty), then, only if the household enabled AI, a batch call to a small model. Low confidence stays in the review inbox. A correction you make updates the memory.
7. Budget lines pick up the categorised rows; recurring payments are detected; alerts and notifications are queued.

## Jobs and the worker

The worker registers pg-boss queues and schedules at start-up: connection sync scheduler and runs, consent-expiry check, categorisation and merchant enrichment (plus hourly sweeps for leftovers), recurring detection, budget alerts, net-worth snapshots, the monthly AI report, the monthly asset valuation, push delivery, a heartbeat, and pruning of old sync data. Jobs are idempotent and keyed (for example one queued sync per connection). The worker exposes `/healthz` and reads the integration settings through a short-lived cache, so a change saved on the Services page reaches it within about a minute.

## Budget, net worth and insights

A household has an annual budget of income, expense and saving lines, each linked to categories (and optionally an account). "Actual" is the sum of booked, non-transfer transactions in the linked categories; saving lines count net flow into their accounts. The transfer plan shows how much to move from the main account to each account every month. Net worth sums accounts, investments, real estate, vehicles and other assets minus loans and mortgages, with monthly snapshots. Insights adds charts, anomaly detection and the monthly report.

## MCP and OAuth

The MCP server is a Streamable HTTP endpoint at `/api/mcp` using the official TypeScript SDK. It authenticates either with **OAuth 2.1** (authorization code with PKCE and dynamic client registration, issued by the app and restricted to an allow-list of redirect URIs, which is what claude.ai connectors use) or with **personal access tokens** (hashed at rest, read or read-and-write scope, expiry, revocable). Every call acts as the person who connected, with at most their role, and every write is audited. See [Connect Claude](mcp.md).

## AI

AI is opt-in twice: the installation needs an Anthropic key and each household switches it on. Requests go from the worker (and the report and valuation jobs) straight to the Anthropic API. Inputs are redacted or aggregated before leaving the server; what exactly is sent is listed in [AI features](ai.md).

## Internationalisation

The interface ships in English, European Portuguese (`pt-PT`), Spanish (`es-ES`), French (`fr-FR`) and Italian (`it-IT`), through next-intl, with the messages in `apps/web/messages/<locale>.json`. The household's locale decides number and date formats; `DEFAULT_LOCALE` sets the language before a person picks theirs. Every new string must exist in all five files.

## White-label

The product name, primary colour and logo are installation settings (`BRAND_NAME`, `BRAND_PRIMARY_COLOR`, `BRAND_LOGO_URL`); icons, the manifest and the social cards are generated from them at runtime, so a fork can rebrand without touching code. See [Configuration](configuration.md).

## Deployment

One image, built once, three commands. `docker compose` and the Helm chart both run `migrate` first (it applies the SQL migrations and creates or updates the `pfm_app` role), then `web` and `worker`. Both deployments use the same hardening: non-root, read-only root filesystem, dropped capabilities. See [Install](install.md), [Kubernetes](kubernetes.md) and [Backup and upgrade](backup-and-upgrade.md).
