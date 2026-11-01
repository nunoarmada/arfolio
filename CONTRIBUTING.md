# Contributing to Arfolio

Thanks for helping out. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) first.

## Prerequisites

- Node.js 22 (see `.nvmrc`)
- pnpm 10 via corepack: `corepack enable`
- PostgreSQL 17 for the tests, reachable through `DATABASE_URL_TEST`
  (for example `postgres://postgres:postgres@localhost:5432/postgres`)

## Scripts

| Script              | Purpose                                  |
| ------------------- | ---------------------------------------- |
| `pnpm install`      | Install workspace dependencies           |
| `pnpm lint`         | ESLint                                   |
| `pnpm typecheck`    | Type-check every workspace package       |
| `pnpm test`         | Run Vitest across all workspace projects |
| `pnpm build`        | Build every package that defines a build |
| `pnpm format`       | Format with Prettier                     |
| `pnpm format:check` | Verify formatting (used in CI)           |

For how the pieces fit together read [docs/architecture.md](docs/architecture.md); the user guides are indexed in the [README](README.md#documentation).

Before opening a pull request, run `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`.

## End-to-end tests

The Playwright suite lives in `apps/web/e2e`. Run it with `pnpm --filter @arfolio/web e2e`. It builds the app
and uses `DATABASE_URL_TEST`, or a throwaway local cluster if unset. Set `E2E_SKIP_BUILD=1` to reuse an
up-to-date `.next` build.

## Demo data

To explore Arfolio with a realistic, fictional household (also what the README screenshots use), create a
household through the normal `/setup` flow, then run:

```
DATABASE_URL=postgres://pfm_app:...@localhost:5432/pfm pnpm demo:seed
```

It adds three accounts, a year of categorised transactions, a budget with lines near or over their limit, a
partly funded goal, a property with its mortgage, and monthly net-worth snapshots. Merchants, names and IBAN
endings are invented. The same seed always builds the same data.

| Option             | Default                  | Meaning                                             |
| ------------------ | ------------------------ | --------------------------------------------------- |
| `--household <id>` | the only household       | Household (organisation) id to fill                 |
| `--months <n>`     | `12`                     | Months of history before the current month          |
| `--locale <l>`     | the household's language | `en` or `pt-PT`: language of descriptions and names |
| `--seed <n>`       | fixed                    | Different seeds give different amounts              |
| `--force`          | off                      | Seed even if the household already has transactions |

The app role (`pfm_app`) is enough: the script goes through the same services as the app. Without
`--force` it refuses a household that already has transactions. With it, a second set of accounts, assets and
goals is added next to the existing ones, so prefer a fresh household.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, ...). They drive
release-please and the changelog.

## Sign-off (DCO)

Contributions are made under the project licence (AGPL-3.0-only) and must carry a
[Developer Certificate of Origin](https://developercertificate.org/) sign-off:

```
git commit -s
```

This adds a `Signed-off-by: Your Name <you@example.com>` line.

## Releases (maintainers)

Releases come from release-please: merging its release pull request creates the tag and publishes the images, after CI passed on that commit. Pushing a `v*` tag by hand also publishes images, **without CI gating** (the first release was cut this way). It is maintainer-only: never tag a commit CI has not passed on.

## User interface strings

Every new UI string must be added to all five files in `apps/web/messages/` (`en`, `pt-PT`, `es-ES`, `fr-FR`, `it-IT`); a parity test fails otherwise.
