# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Copilot, Cursor and others) working on this repository.
Human contributors: the same rules apply; [CONTRIBUTING.md](CONTRIBUTING.md) has the setup details.

## What this project is

Arfolio is an **open-source, self-hosted** household finance app (AGPL-3.0-only). People deploy it on their own
server with Docker Compose or Helm and connect their own bank accounts, broker and AI key. There is **no hosted
service and no central operator**: every installation is run by its owner.

That shapes every change:

- **Everything must be generic.** Write for any household, any country, any bank. Never hard-code a person, a
  bank, a broker account, a city, a currency or a language as an assumption. Country- or bank-specific behaviour
  is a configurable default, a setting, or an import preset that users choose.
- **No personal data, ever.** Not in code, tests, fixtures, comments, docs, screenshots, commit messages or PR
  descriptions: no real names, emails, IBANs, account numbers, addresses, hostnames, IPs, internal URLs or
  session links. Use obviously fictional data ("Example Bank", "Mercado Central") and published specimen IBANs
  (`DE89370400440532013000`, `PT50000201231234567890154`).
- **No secrets in the repo.** Test keys must be visibly fake (`sk-ant-e2e-fake-key-…`). Never commit `.env`
  files, dumps, exports or real API responses.
- **Privacy by design.** Users trust their installation with their finances. Data leaves the server only to the
  services the owner configured (Enable Banking, Trading 212, Anthropic, SMTP, push services, the favicon
  service for merchant logos, which can be turned off). Do not add telemetry, analytics, external fonts/CDNs or
  any new outbound call without an explicit, documented opt-in.
- **Brand-neutral code.** The product name, colour and logo come from `BRAND_NAME`, `BRAND_PRIMARY_COLOR` and
  `BRAND_LOGO_URL`; forks rebrand without touching code. Use the brand helpers, never a literal "Arfolio" in UI
  code. See [TRADEMARK.md](TRADEMARK.md).

## Repository map

| Path                  | What lives there                                                             |
| --------------------- | ---------------------------------------------------------------------------- |
| `apps/web`            | Next.js app: UI, server actions, API routes, MCP endpoint, Playwright e2e    |
| `apps/worker`         | pg-boss worker: bank sync, AI jobs, sweeps, push delivery                    |
| `packages/core`       | Pure logic shared everywhere: env parsing, crypto, money, brand, transfers   |
| `packages/db`         | Drizzle schema, hand-written SQL migrations, roles, tenancy helpers          |
| `packages/services`   | Domain services used by web, worker and MCP                                  |
| `packages/connectors` | Enable Banking and Trading 212 clients                                       |
| `packages/mcp`        | MCP tools exposed to Claude and other MCP clients                            |
| `deploy/helm`         | Helm chart; `compose.yaml` and `scripts/init-env.sh` are the Compose install |
| `docs/`               | User and architecture docs (CC BY 4.0)                                       |

Read [docs/architecture.md](docs/architecture.md) before structural changes.

## Commands

```sh
pnpm install
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test   # run before every commit
pnpm build
pnpm --filter @arfolio/web e2e                                   # Playwright suite
```

Tests need PostgreSQL 17 via `DATABASE_URL_TEST` (e.g. `postgres://postgres:postgres@localhost:5432/postgres`).
While iterating, run the focused file (`pnpm vitest run <path>`); run the full suite once before committing.

## Rules

### Data and security

- **Tenant isolation.** Every query on household data runs inside `withHousehold(...)` and filters by
  `household_id`; Postgres RLS is the second layer, not a replacement. The app role `pfm_app` has no DDL.
- **Secrets are write-only.** Integration secrets are stored encrypted (`ENCRYPTION_KEY`, AES-GCM with AAD) and
  are never returned to the browser, logged, put in error messages or written to `audit_log` (record key names
  only). Sanitise third-party error text before showing it.
- **Precedence of settings:** environment variable → value saved in Settings → Services → default. Keep it.
- **Owner-only, fresh session** for anything that changes instance-level settings.
- **AI calls** send the minimum: redact personal data (`packages/services/src/ai/redact.ts`), send aggregates
  where possible, and respect the household's AI opt-in. Document any new data sent in `docs/ai.md`.
- **Logs** carry ids and messages, never amounts, descriptions, names or tokens.

### Compatibility

- Existing installations must keep working after an upgrade. Do not rename technical identifiers: the `pfm`
  database name, `pfm_app`/`pfm_owner` roles, cookie names, storage keys, service-worker caches, PAT prefix
  `pfm_pat_` and scopes `pfm:read`/`pfm:write`, Helm resource names.
- **Migrations** are additive, hand-reviewed SQL in `packages/db/migrations/` with the Drizzle journal and
  snapshot; never edit an applied migration. Run `prettier --write` on the generated `meta/*.json`.
- New env vars are optional with safe defaults, documented in `.env.example` and `docs/configuration.md`, and
  passed through in `compose.yaml` and the Helm chart where users need them.

### Code

- Follow the existing patterns and libraries; check the installed version of a library before using its API.
  Do not add dependencies without a clear need, and say why in the PR.
- TDD: write the failing test first, then the code. Never skip, weaken or delete a test to get green.
- Handle errors explicitly; no silent catches. Validate input at system boundaries (server actions, API, env).
- Keep changes small and focused; no unrelated refactors or formatting churn.
- **UI strings** go in all five files in `apps/web/messages/` (`en`, `pt-PT`, `es-ES`, `fr-FR`, `it-IT`) with
  identical placeholders; a parity test enforces it. Money must go through the formatting helpers so privacy
  mode can mask it.
- UI follows `docs/design/design-system-v2.md`: semantic HTML, labels, keyboard access, ≥ 44 px targets,
  light/dark, 390 px mobile, loading/empty/error states.
- **e2e specs share one database and one household**: clean up every row your spec writes (including
  `audit_log`) in `afterAll`.

### Commits and pull requests

- Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `ci:` …); they feed release-please and
  the changelog. Sign off every commit (`git commit -s`, DCO).
- One topic per PR; fill in the PR template; CI (format, lint, typecheck, unit, e2e, Helm, Docker build) must be
  green.
- Never push tags or publish releases; maintainers do that (see CONTRIBUTING.md).
- Update docs and `CHANGELOG`-relevant commit messages when behaviour changes.

## Before you finish

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` pass
- [ ] New strings in all five locales
- [ ] No personal data, secrets, hard-coded bank/country/brand assumptions
- [ ] Docs updated if users would notice the change
