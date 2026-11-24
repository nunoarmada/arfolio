# Stack upgrade and import follow-ups: design

Approved by the owner on 2026-11-24.

## Intent

Close the open points left after the PDF statement import (0.7.0) and bring every dependency and the runtime
up to date, then release and deploy. Everything stays generic: Arfolio is self-hosted by anyone, for any bank,
country and language.

## Goals

1. **Dependencies:** every dependency at its latest release, including majors, except where noted below.
   This includes the Next.js release that fixes the security advisory shown by `next build`.
2. **Runtime and tooling:** Node 26 (current LTS) in the Docker image, CI and `engines`; pnpm 12.
3. **Removed API key honoured everywhere at once:** when an owner saves or removes an integration setting,
   every process (all web replicas and the worker) drops its cached configuration immediately, not after up to
   30 seconds.
4. **Invalid model name:** the PDF import (and any other AI call that reports provider errors to the person)
   says the configured model is not available instead of "could not be reached"; **Test** in Settings ›
   Services › AI also checks the configured model names.
5. **PDF already read:** returning to the upload step with an extraction for the same file and account offers
   "Continue with what was read" next to sending again.
6. **Legacy Excel limits:**
   - a cell text over the limit only rejects the file when that cell is read (not when it sits in another sheet);
   - a shared string table that declares more strings than it holds is read as far as it goes when its data
     ends exactly at a string boundary;
   - the workbook stream is found by walking the compound file's directory tree from the root, not by entry
     order.
7. **Genericity audit:** every change since v0.5.0 is checked for personal data and for country-, bank- or
   language-specific assumptions; what it finds is fixed in this work.
8. **Testing:** full unit suite, full e2e suite, Docker image built and started, one independent final review.

## Non-goals

- PostgreSQL server major upgrade (17 → 18): existing installations would have to migrate their data by hand;
  stays at 17 in Compose, Helm and CI.
- TypeScript 7: `typescript-eslint` supports TypeScript only up to 6.0; stays on the latest 6.x.
- Testing against the real Anthropic API (no key in this environment); the 200-movement limit stays an
  estimate.
- Moving PDF extraction to the worker.

## Constraints

- Existing installations keep working after the upgrade (AGENTS.md compatibility rules); no new required
  environment variable.
- Any upgrade that breaks something it cannot be made to work with in reasonable effort is held back to the
  newest version that works, and reported.
- No new outbound call; no new dependency unless it replaces one being removed.

## Approaches

- **Cross-process invalidation:** chosen: Postgres `LISTEN/NOTIFY` on a fixed channel, sent in the same
  transaction that writes an instance setting; every process listening drops its cache on a notification and
  on reconnect. Rejected: a shorter TTL (still a window, more queries); reading the settings on every AI call
  (extra query per call, and other integrations keep the window).
- **Upgrades:** one commit per major (each with its tests green), minors together; Node and pnpm together
  because the lockfile and image depend on both.

## Left to the builder

Exact copy (five locales), the channel name, how the listener reconnects, how "Continue with what was read" is
laid out within the existing upload step, and which code changes each major needs.
