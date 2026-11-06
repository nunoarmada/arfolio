# Holdings grouped by Trading 212 pie — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the holdings of a Trading 212 account grouped by pie, each pie with its instruments, plus an "Outside pies" group.

**Architecture:** The daily pie-detail call that already reads the pie name also returns its instruments. We store them in a new `investment_bucket_holding` table. `listHoldings` builds groups from those rows plus the position snapshot, and the holdings section renders the groups.

**Tech Stack:** TypeScript, Drizzle 0.45 + hand-written SQL migration, Vitest, Next.js/next-intl, Tailwind.

**Spec:** `docs/superpowers/specs/2026-11-06-trading212-pie-holdings-design.md`

## Global Constraints

- Migration additive, `0049_investment_bucket_holding.sql`, RLS `household_isolation` policy like 0046; never edit applied migrations; prettier on `meta/*.json`.
- Composite FKs `(bucket_id, household_id)` → `investment_bucket`, `(account_id, household_id)` → `financial_account`, both `ON DELETE cascade`.
- No new provider calls; pies never fail a sync.
- UI strings in all five `apps/web/messages/*.json`; money via `MoneyAmount`/format helpers.
- Conventional commits, signed off (`git commit -s`).

## Review Focus

- Instrument held both inside a pie and outside it: the "Outside pies" item has the remainder (quantity, value, cost).
- Pie data older than the positions (detail failed today): use the latest holding day, never crash. Remainder ≤ 0 is dropped.
- Pie instrument with no matching position (sold since detail read): shown with ticker as name.
- Account with buckets but no holding rows (pre-upgrade): `groups` is null, flat view as today.
- Foreign-currency position: stays in "Outside pies" untouched, excluded from total/weights as today.

---

### Task 1: Connector — `getPieDetail`

**Files:** Modify `packages/connectors/src/trading212/map.ts`, `packages/connectors/src/trading212/client.ts`, `packages/connectors/src/index.ts` (export types if needed); Test `packages/connectors/test/trading212/client.test.ts`.

**Interfaces — Produces:**
- `type ProviderPieInstrument = { ticker: string; quantity: string; invested: number; value: number }` (minor units of account currency)
- `type ProviderPieDetail = { name: string; instruments: ProviderPieInstrument[] }`
- `client.getPieDetail(id: string, currency: string): Promise<ProviderPieDetail>` replacing `getPieName`.
- Mapping: `settings.name` → name; `instruments[].ticker`, `ownedQuantity` → quantity (decimal string), `result.priceAvgInvestedValue` → invested, `result.priceAvgValue` → value; null numbers → 0; missing `instruments` → `[]`.

- [ ] Rewrite the `getPieName` tests as `getPieDetail` tests: name + two instruments mapped (`ownedQuantity: 1.5` → `'1.5'`, `priceAvgInvestedValue: 10.25` → `1025`); null result → zeros; missing name / non-object instrument / unsafe id → `ProviderResponseError`.
- [ ] Run `pnpm vitest run packages/connectors/test/trading212` → FAIL.
- [ ] Implement `mapTrading212PieDetail(raw, currency)` in map.ts and `getPieDetail` in client.ts.
- [ ] Re-run → PASS.

### Task 2: DB — `investment_bucket_holding`

**Files:** Modify `packages/db/src/schema/investments.ts`; Create `packages/db/migrations/0049_investment_bucket_holding.sql` + meta; Test `packages/db/test/rls-phase3.test.ts`.

**Produces:** `schema.investmentBucketHolding` with `bucketId, householdId, accountId, asOf, ticker, quantity (numeric 28,10), investedMinor, valueMinor (bigint), currency char(3)`; PK `(bucket_id, as_of, ticker)`; index `(account_id, as_of)`.

- [ ] Add the table to `ALL_TABLES` and a test "investment_bucket_holding: primary key, pinned account and bucket cascade" mirroring the snapshot one.
- [ ] Run `pnpm vitest run packages/db/test/rls-phase3.test.ts` → FAIL.
- [ ] Add schema, `pnpm --filter @arfolio/db generate`, append RLS lines, prettier meta.
- [ ] Re-run → PASS.

### Task 3: Sync — store pie instruments

**Files:** Modify `packages/services/src/sync.ts` (`saveBuckets`), `packages/services/src/connections.ts` (`Trading212Port`), `packages/services/test/connector-fakes.ts`, `packages/services/test/sync.test.ts`, worker test fakes (`apps/worker/src/jobs/sync-jobs.test.ts`, `t212-export.test.ts`).

- [ ] Rename fake calls to `getPieDetail:<id>`, fake field `pieInstruments: Record<string, ProviderPieInstrument[]>`; extend the first pies test: after first run, `investment_bucket_holding` has the rows for the day; on a same-day repeat run (no detail read) the rows are kept; next day they are replaced.
- [ ] Test: a pie whose detail throws `ProviderResponseError` keeps its bucket/snapshot and has no holding rows that day.
- [ ] Run → FAIL. Implement: collect `details` map; in the transaction delete holding rows `(account, day, bucket in read set)` and insert new ones. Re-run → PASS.

### Task 4: Service — `groups` in `listHoldings`

**Files:** Modify `packages/services/src/holdings.ts`; Test `packages/services/test/holdings.test.ts`.

**Produces:**
```ts
interface HoldingGroup { id: string | null; name: string | null; currency: string;
  value: string; cost: string; profit: string; profitBps: number | null; weightBps: number | null;
  items: Holding[] }
Holdings.groups: HoldingGroup[] | null
```
Pies sorted by value desc, then outside (`id: null`) last. Weights relative to `total`. Item name/isin from the position with the same ticker on the positions' latest day.

- [ ] Tests: `groups` null without holding rows; two pies + an instrument split pie/outside → exact groups (values, cost, profit, bps, remainder quantity `'2.5'`); remainder ≤ 0 dropped; foreign position in outside group.
- [ ] Run → FAIL; implement; → PASS.

### Task 5: UI — grouped holdings

**Files:** Modify `apps/web/src/components/accounts/holdings-section.tsx`, `apps/web/src/server/holdings-data.ts` (renderable checks groups), five `apps/web/messages/*.json` (`accounts.holdings.outsidePies`, `pieMeta`).

- [ ] When `groups` exists: table renders per group a `<tbody>` with a header row (`<th scope="rowgroup">` name, value, gain, weight) followed by item rows; mobile renders a heading per group then its list. "Show all" truncation is not applied in grouped mode (builder call).
- [ ] `pnpm --filter @arfolio/web typecheck`, `pnpm vitest run apps/web` (message parity) → PASS.

### Task 6: Verify & ship

- [ ] `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`, `pnpm build`.
- [ ] Commit (signed off), push, PR, merge, deploy as the project deploys.
