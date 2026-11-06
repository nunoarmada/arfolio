# Holdings grouped by Trading 212 pie — design

Status: draft, awaiting approval · Size: small-to-medium change (schema + sync + service + UI)

## Intent

On an investment account linked to Trading 212, the "Investments" section lists one row per
instrument (`/equity/positions` aggregates every pie). Users who organise their money in pies want to
see the portfolio the way they built it: each pie with the instruments that belong to it.

## Goals

- The holdings section of a Trading 212 account groups instruments by pie. Each pie header shows
  name, value, gain/loss (amount and %) and weight. Under it are its instruments with quantity,
  value, gain/loss and weight.
- Per-pie numbers are the ones Trading 212 reports for that pie (`result.priceAvg*`), so they match
  the Trading 212 app.
- Whatever is held outside pies (whole positions, or the part of a position not in any pie) shows in
  an "Outside pies" group, derived as position minus the sum held in pies.
- The grand total stays the account-currency positions total, as today.

## Non-goals

- No new requests to Trading 212. The pie detail (`GET /equity/pies/{id}`) is already fetched once a
  day for the name; we keep the instruments from that same response.
- No pie management, target allocation (`expectedShare`) or "issues" display.
- No change to net worth, balances, budgets or MCP tools.

## Anti-goals

- A sync must never fail because of pies (keeps today's "pies skipped" behaviour).
- Accounts without pies, and non-Trading 212 investment accounts, look exactly as today.
- No hard-coded bank, currency or pie assumptions; works for any account currency.

## Approaches considered

1. **Per-pie values from Trading 212 (chosen).** Store each pie's instruments (quantity, invested,
   value) from the pie detail. They match the Trading 212 app. The drawback is that the detail is read
   once a day, so pie figures can lag the account total by some hours.
2. Store only quantities per pie and split the current position value pro rata. Totals are always
   consistent, but the gains are computed by us and differ from Trading 212. Rejected by the user.
3. Fetch pie details when the page renders. Rejected: pages never call providers, and the rate limit
   is 1 request / 5 s per pie.

## Decided how

- **Connector** (`packages/connectors/src/trading212`): replace `getPieName(id)` with
  `getPieDetail(id, currency)` returning `{ name, instruments: [{ ticker, quantity, invested, value }] }`.
  Money is converted to minor units of the account currency, and quantity is a decimal string.
  Null or missing numbers count as zero, as in `mapTrading212Pie`. A malformed item throws
  `ProviderResponseError`, as today for the name.
- **DB**: new additive migration `0049_investment_bucket_holding.sql`, table
  `investment_bucket_holding` with `bucket_id`, `household_id`, `account_id`, `as_of`, `ticker`,
  `quantity numeric(28,10)`, `invested_minor`, `value_minor` and `currency`. The PK is
  `(bucket_id, as_of, ticker)`. It uses composite FKs to bucket and account with cascade, plus
  RLS policies and grants that copy `investment_bucket_snapshot` from 0046. Journal and snapshot
  are regenerated and prettier-formatted.
- **Sync** (`saveBuckets`): the per-pie detail call is the existing name call, so its cadence is
  unchanged: new pies, and every pie on the first sync of the day. Holdings rows for that day are
  replaced for the pies whose detail was read. A pie whose detail failed keeps no rows for the day.
- **Service**: `listHoldings` gains `groups`, which is `null` when the account has no bucket
  holdings on the latest bucket day. Each group is `{ id, name, value, cost, profit, profitBps,
  weightBps, items: Holding[] }`, sorted by value. "Outside pies" is a group with `id: null`, built
  from position quantity/value minus the pie totals per ticker, and drops out when ≤ 0. Name and ISIN
  for a pie instrument come from the position snapshot by ticker. The existing `items` stay, for the
  MCP and other callers.
- **UI** (`holdings-section.tsx`): when `groups` is present, the table renders a group header row
  per pie, then its instruments. On mobile the same groups render as headed lists. The flat view
  stays when `groups` is null. New strings ("Outside pies", group labels) go in all 5 locales.
  The design system covers light/dark, 390 px, keyboard and screen-reader captions.

## Left to the builder

- Exact Trading 212 field names in the pie detail `instruments` items. We expect `ticker`,
  `ownedQuantity`, and `result.priceAvgInvestedValue` / `result.priceAvgValue`, but the official docs
  could not be fetched from this environment. Confirm them against a real response (the user can share
  a redacted one) before merging. The Trading 212 docs now mark the Pies API "deprecated", but it
  still works.
- Whether "show all (10)" truncation applies per group or is dropped in grouped mode.
- Visual treatment of group header rows within `docs/design/design-system-v2.md`.
