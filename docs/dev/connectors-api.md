# Connector API reference: Enable Banking + Trading 212

Compiled 2026-10-18. Vendor sites (enablebanking.com, docs.trading212.com, jentic, glama) were NOT reachable from the
research sandbox (DNS failure), so nothing here was read from the vendor's live docs. Evidence is open-source code and
specs pulled from npm/PyPI/raw.githubusercontent. Every claim carries a tag:

- [V-spec]  read from Trading 212's official OpenAPI file (shipped inside an npm package, see S-T1). Strong evidence.
- [V-code]  observed in working third-party client code (>=2 independent clients agree unless noted). Good evidence.
- [V-1]     observed in a single third-party client. Treat as probable.
- [UNVERIFIED] from model memory or general PSD2 knowledge, no source found. Confirm against the vendor docs before relying on it.

## Sources (local copies in the research scratchpad, re-fetchable)

Scratchpad root: /tmp/claude-0/-home-user/44b8268f-5471-5a62-9055-a2812a593bda/scratchpad/apis

| Id | Package / URL | What it gave |
|----|---------------|--------------|
| S-E1 | npm `enable-banking-mcp@0.3.0` (MIT, github.com/marcosvrs/enable-banking-mcp), file dist/enable-banking.js | JWT format, endpoints, request bodies, error handling, tx query params |
| S-E2 | npm `saldo-mcp@0.2.0`, dir dist/providers/enablebanking/{jwt,types.d,mappers,client}.js | JWT (24h max note), response types, tx mapping, 401 retry |
| S-E3 | PyPI `enablebanking-sdk@0.1.7` (MIT, github.com/nocfo/enablebanking_sdk), models/*.py, constants/*.py, service/integration.py | Pydantic models for /aspsps, /auth, /sessions, balances, transactions; enums; PSU-header passthrough |
| S-E4 | PyPI `pretix-enablebanking@1.0.4` (MIT, github.com/nicoknoll/pretix-enablebanking) | maximum_consent_validity in seconds, continuation_key loop, sandbox credentials, tx field use |
| S-E5 | https://raw.githubusercontent.com/enablebanking/enablebanking-api-samples/master/README.md | Official samples repo; app registration via enablebanking.com/cp/applications, key downloaded as `<appId>.pem` |
| S-E6 | Web search snippet of https://enablebanking.com/docs/api/quick-start (secondary) | Flow: POST /auth -> redirect -> `code` -> POST /sessions -> session_id + accounts; `aud` = api.enablebanking.com; RS256 |
| S-T1 | npm `@abaddon83/trading212-mcp@1.0.0` file docs/api.json (published 2026-07-10) | Official Trading 212 OpenAPI spec copy (title "Trading 212 Public API", v0). Basis for all T212 facts marked [V-spec] |
| S-T2 | https://raw.githubusercontent.com/zaini/trading212-sdk/main/docs/api-gotchas.md and npm `@azaini/t212-sdk`, `t212-sdk` | Community gotchas, pagination bugs, demo limits, error shapes |
| S-T3 | npm `trading-212-client@1.0.1` (older client) | Shows the OLD endpoints/auth (legacy) |
| S-T4 | Web search results (secondary): docs.trading212.com/api/historical-events/transactions, community.trading212.com/t/trading-212-api-update/87988 | Confirms 6 req/min on transactions; forum report of 404 on later pages |

The spec copy is a snapshot from July 2026. Re-diff against https://docs.trading212.com/api (the `api.json` linked there) before release.

---

## 1. Enable Banking

Base URL: `https://api.enablebanking.com` [V-code S-E1, S-E2, S-E3, S-E4]. (`api.tilisy.com` is the deprecated old host [secondary S-E6].)
Unauthenticated: `GET /health` [V-1 S-E1]. All other calls: `Authorization: Bearer <JWT>`.

### 1.1 Application registration and JWT

- Register an application in the Control Panel (https://enablebanking.com/cp/applications); the private key can be generated in the browser and downloads as `<applicationId>.pem`. Application id == JWT `kid` [S-E5, S-E3 README: "app_id ... used in the JWT header as kid"].
- Environments: an application is `PRODUCTION` or `SANDBOX` (field `environment`) [V-1 S-E1 application type, setup.js]. `GET /application` returns `{name, description, kid, environment, redirect_urls[], active, countries[], services[]}` [V-1 S-E1]. Use `active` to detect whether a restricted-production app has been linked/activated.
- Registration body fields seen (Control Panel API, not the public API, so low priority): `name, certificate, environment, redirect_urls[], description, gdpr_email, privacy_url, terms_url` [V-1 S-E1 setup.js]. Redirect URLs must be pre-registered; the MCP uses https loopback URLs.
- JWT, confirmed identically in four independent implementations [V-code S-E1, S-E2, S-E3, S-E4]:
  - Header: `{"typ":"JWT","alg":"RS256","kid":"<applicationId>"}`
  - Claims: `{"iss":"enablebanking.com","aud":"api.enablebanking.com","iat":<unix s>,"exp":<unix s>}`
  - Lifetime: S-E2 states max TTL is 24h (comment, V-1; matches the brief). Clients use 300 s (S-E1), 3600 s (S-E2, S-E3, S-E4). Recommend 1h, cache, and refresh 60 s before expiry; on 401 re-sign once and retry (S-E2 does this).
  - Signature: RSA-SHA256 over `base64url(header).base64url(payload)`. Key may be PKCS#8 or PKCS#1 PEM.
- Use UTC unix seconds for `iat`/`exp`. Note S-E3 uses naive `datetime.now()`; do not copy that.

### 1.2 Flow

1. `GET /aspsps?country=PT&psu_type=personal[&service=AIS]` -> `{aspsps:[...]}`.
2. `POST /auth` -> `{url, authorization_id, psu_id_hash?}`. Redirect the user to `url` (must be https; S-E1 validates this).
3. Bank/EB redirects to your registered `redirect_url` with `?code=...&state=...` (on failure presumably `error` params; shape [UNVERIFIED]). Verify `state` equals what you sent (constant-time compare).
4. `POST /sessions {"code": "<code>"}` -> session with `session_id`, `accounts[]`, `aspsp`, `psu_type`, `access`. The code is single-use and short-lived [UNVERIFIED expiry]; exchange immediately in the callback handler.
5. Per account `uid`: `/details`, `/balances`, `/transactions`.
6. Re-consent before `access.valid_until`; `DELETE /sessions/{id}` to revoke.

### 1.3 Endpoints and payloads

`GET /aspsps` query: `country` (ISO 3166-1 alpha-2), `psu_type` (`personal|business`), `service` (`AIS`, used by S-E1) [V-code S-E1, S-E3]. Response item (S-E3 `AspspData`, S-E2 `EBAspsp`) [V-1 each]:
`{name, country, bic?, logo, beta?: bool, maximum_consent_validity: int, required_psu_headers: string[], psu_types: ["personal"|"business"], auth_methods:[{name?, title?, psu_type, approach: REDIRECT|DECOUPLED|EMBEDDED, hidden_method: bool, credentials:[{name,title,required,description?,template?}]}]}`.
`maximum_consent_validity` is in SECONDS [V-1 S-E4 code comment "(seconds)"]. Identify a bank by `(name, country)`, there is no opaque id; store both [V-code S-E2, S-E4]. `name` match must be exact (S-E1 falls back to case-insensitive).

`POST /auth` body [V-code S-E1, S-E3, S-E4]:
```json
{
  "aspsp": {"name": "Mock ASPSP", "country": "FI"},
  "state": "<>=43 char random, e.g. 32 bytes base64url>",
  "redirect_url": "https://app.example/callback",
  "psu_type": "personal",
  "access": {"valid_until": "2026-12-01T10:00:00.000000+00:00", "balances": true, "transactions": true},
  "language": "en",
  "psu_id": null,
  "auth_method": null
}
```
- `valid_until`: RFC 3339 datetime with offset, in the future, and <= now + the ASPSP's `maximum_consent_validity` (otherwise a 4xx is expected, exact error [UNVERIFIED]). S-E4 computes `now + maximum_consent_validity` and falls back to 90 days; S-E2 comment says EB caps at ~180 days; S-E1 defaults to 30 days. So derive from /aspsps, never hard-code.
- `access.balances`/`transactions` booleans appear in S-E1/S-E2/S-E3; `access.accounts` (list of identifications) is optional [V-1 S-E3].
- `language` is required by S-E3's model but omitted by S-E1/S-E4 requests that work; treat as optional [V-code, conflicting].
- `psu_type`: S-E3 defaults to `business` if omitted, S-E4/S-E1 always send `personal`. Always send explicitly. Personal finance app: `personal`.
- `state`: opaque string echoed back; S-E1 uses 256-bit base64url, S-E4 a UUID4. Both work.

`POST /sessions` body `{"code": string}`. Response [V-1 S-E3 model, S-E2 type]:
```
{ session_id, aspsp:{name,country}, psu_type, access:{valid_until, balances?, transactions?, accounts?},
  accounts:[{ uid, account_id?:{iban?, other?:{identification, scheme_name, issuer?}}, all_account_ids?:[{scheme_name, identification}],
              name?, details?, currency, cash_account_type, product?, identification_hash, identification_hashes[] }],
  status? }
```
- `uid` is the id used in all `/accounts/{uid}/...` paths. It is session-scoped: a re-consent yields new uids. Use `identification_hash` (stable across sessions per S-E3 naming, [UNVERIFIED semantics]) or IBAN to link a new session's accounts to existing local accounts.
- IBAN may be absent (`account_id.other` or `all_account_ids` with `scheme_name` IBAN/BBAN/MIBN); S-E2 falls back to the `all_account_ids` entry with scheme IBAN.

`GET /sessions/{session_id}` [V-1 S-E1] returns the session (same shape plus status; status values [UNVERIFIED]). `DELETE /sessions/{session_id}` [V-code S-E1, S-E3] (accepts PSU headers).

`GET /accounts/{uid}/details` -> `{uid?, name?, currency?, account_id?:{iban?}, all_account_ids?, ...}` [V-1 S-E2].

`GET /accounts/{uid}/balances` -> `{balances:[{name, balance_amount:{amount:"123.45", currency}, balance_type, reference_date?, last_change_date_time?, last_committed_transaction?}]}` [V-code S-E2, S-E3]. `balance_type` enum (ISO 20022) [V-1 S-E3]: CLAV, CLBD, FWAV, INFO, ITAV, ITBD, OPAV, OPBD, OTHR, PRCD, VALU, XPCD. Banks return different subsets: prefer `ITAV`/`CLAV` for "available", `CLBD`/`ITBD` for "booked", fall back to the first one; store the type with the snapshot.

`GET /accounts/{uid}/transactions` query [V-code S-E1, S-E3, S-E4]:
- `date_from`, `date_to`: `YYYY-MM-DD` (S-E3 formats this way). `date_to` without `date_from` is rejected by the MCP client (rule of that client; API behaviour [UNVERIFIED]).
- `continuation_key`: from previous page; loop until absent/null (S-E1, S-E4). Guard against a repeated key (S-E1 does; real-world bug).
- `transaction_status`: one of BOOK, CNCL, HOLD, OTHR, PDNG, RJCT, SCHD [V-1 S-E1]. Omitted = bank default (typically booked only [UNVERIFIED]). Request `BOOK` and `PDNG` in separate calls if you want pending, but note this doubles quota use (see 1.5).
- `strategy`: `default` | `longest` [V-1 S-E1, S-E3 enum]. `longest` makes EB try to fetch the longest history by multiple bank calls.
- There is no page-size param; page size is bank-defined.
Response: `{transactions:[...], continuation_key?: string|null}`. Transaction [V-code S-E2, S-E3, S-E4]:
```
{ entry_reference?, transaction_id?, status: "BOOK"|"PDNG"|..., credit_debit_indicator: "CRDT"|"DBIT",
  transaction_amount:{amount:"12.34", currency:"EUR"},        // amount is a positive decimal STRING
  booking_date?, value_date?, transaction_date?,               // YYYY-MM-DD
  creditor?:{name?}, debtor?:{name?}, creditor_account?:{iban?,...}, debtor_account?:{iban?,...},
  remittance_information?: string[], reference_number?, note?, merchant_category_code?,
  balance_after_transaction?:{amount,currency}, bank_transaction_code?:{description?, code?, sub_code?} }
```
- Amount is unsigned; sign comes from `credit_debit_indicator` (DBIT negative) [V-code S-E2]. Parse as decimal string, never float (S-E3 models it as float: avoid).
- `transaction_id` and `entry_reference` are each frequently null and banks vary; S-E2 falls back to a synthetic SHA-1 of account|date|amount|indicator|text so re-fetches dedupe [V-1]. Do the same, but include a within-day occurrence counter, otherwise two identical same-day purchases collapse.
- `GET /accounts/{uid}/transactions/{transaction_id}` exists [V-1 S-E1], not needed for ingest.
- Fields booking_date may be missing for pending rows; use value_date/transaction_date.

### 1.4 Restricted (personal) production mode and sandbox

- "Restricted production" lets an individual use PRODUCTION with their OWN bank accounts without a commercial agreement: you register an app with `environment: PRODUCTION`, then must link your own accounts to the app in the Control Panel; the app stays `active:false` until linked (S-E1 polls `GET /application` until `active:true`) [V-1 S-E1 setup.js; README of that project]. Privacy URL, terms URL and GDPR email are required for PRODUCTION registration [V-1 S-E1]. Personal, noncommercial use only [V-1 S-E1 README, repeating provider terms; exact EB wording [UNVERIFIED]].
- Consequences for the design: single user, accounts must be pre-linked in the Control Panel, `psu_type=personal`, list of usable ASPSPs/countries is `application.countries` and `GET /aspsps`. Whether linking is per bank account or per ASPSP [UNVERIFIED].
- Sandbox: app with `environment: SANDBOX`. ASPSP names containing "Mock" are mock banks (pretix treats `'mock' in aspsp_name.lower()` as sandbox) [V-1 S-E4]. Exact name "Mock ASPSP" and its country list [UNVERIFIED]: query `GET /aspsps` with the sandbox app and pick it. Another sandbox bank: "Aachener Bank" (DE) with VR NetKey `VRK1234567890ALL`, PIN `password`, OTP `123456` [V-1 S-E4 README].
- Sandbox data is synthetic: no real rate limits, and not representative of null `transaction_id` etc. Build the null-id and no-IBAN handling from fixtures.

### 1.5 Rate limits, unattended access, errors

- Error body shape [V-1 S-E1 extractErrorDetails]: JSON with `message` (or `error`/`detail` string) and numeric `code`; may be non-JSON text. `Retry-After` header is read by S-E1 on errors (presence on 429 [UNVERIFIED]). Do not parse text; branch on HTTP status, log the body.
- Known/likely status handling [UNVERIFIED unless noted]: 401 bad/expired JWT (re-sign + retry once, V-code S-E2); 400/422 invalid params (e.g. `valid_until` beyond max, V-1 inferred); 429 bank-side rate limit; 5xx/timeouts from bank (retry with backoff, EB proxies bank errors).
- PSD2 unattended limit: banks may allow only ~4 account-information requests per account/endpoint per day when the PSU is not present [secondary: TrueLayer docs via search, describes the industry rule, not EB; EB numbers UNVERIFIED]. Mitigation EB offers: forward PSU headers so the bank treats the call as user-initiated. The ASPSP lists the headers it wants in `required_psu_headers` [V-1 S-E3]; clients accept a `psu_headers` dict and pass it as HTTP request headers on balances/transactions/details/DELETE session [V-code S-E3]. Header names (e.g. `psu-ip-address`, `psu-user-agent`) are [UNVERIFIED] from memory; read them from `required_psu_headers` at runtime instead.
- Design rule for a self-hosted single-user app: scheduled/background sync = unattended. Budget at most 1 sync of balances + 1 of transactions per account per ~6h (<=4/day), cache everything (S-E2's cache comment: provider calls "often rate-limited per account per day"), page with `continuation_key` in the same run, make "Refresh now" user-initiated and attach PSU headers (client IP + UA) where required. On 429, stop for that account until next window, surface "bank rate limit" to the user, never tight-loop.
- Consent expiry: store `access.valid_until` per session and warn at T-14d / T-3d; after expiry the session fails (status code [UNVERIFIED]) and the user must redo /auth.

---

## 2. Trading 212 public API (v0, beta)

Spec: official OpenAPI, title "Trading 212 Public API", version v0 [V-spec S-T1]. Only Invest and Stocks ISA accounts; multi-currency accounts unsupported (all values in the account's primary currency); SIPP/CFD unsupported [V-spec; S-T2].

### 2.1 Environments and auth (changed in 2025: now key + secret Basic)

- Live `https://live.trading212.com/api/v0`, demo (paper) `https://demo.trading212.com/api/v0` [V-spec]. A key belongs to one environment and one account; cross-use gives 401 [S-T2].
- CURRENT auth: HTTP Basic, username = API key, password = API secret: `Authorization: Basic base64("<API_KEY>:<API_SECRET>")` (use `echo -n`, no newline) [V-spec: securityScheme `authWithSecretKey` type http/basic; quickstart cURL]. The secret is shown only once at key creation [S-T2, single-source].
- LEGACY: the spec still lists a second scheme `legacyApiKeyHeader` (apiKey in header `Authorization`), i.e. the raw key alone in `Authorization` (this is what the older client S-T3 sends: `Authorization: this.#apiKey`). Whether old key-only credentials still work in Oct 2026 is [UNVERIFIED]; build for Basic key:secret only and treat 401 as "re-enter key+secret".
- Keys have scopes; missing scope -> 403 with message like `Scope( history:transactions ) missing for API key` [V-spec 403 descriptions]. Required scopes seen: `account` (summary), `portfolio` (positions), `history:transactions`, `history:dividends`, `history:orders`; exports: "Missing Permissions" (scope name not stated). Ask the user to enable at least those five read scopes and NOTHING with order execution. Optional IP allowlist per key [V-spec].
- Server-side only, no CORS [S-T2].

### 2.2 Endpoints relevant to ingest

IMPORTANT: the endpoints named in the task brief (`/equity/account/cash`, `/equity/account/info`, `/equity/portfolio`) are the OLD API. The current spec (July 2026) has no such paths; use the replacements below. Old client S-T3 still targets the old ones [V-code], so do not copy old wrappers. The old paths may still respond (deprecated) [UNVERIFIED].

| Purpose | Method + path (under /api/v0) | Rate limit [V-spec] | Scope |
|---|---|---|---|
| Account cash + totals | GET /equity/account/summary | 1 req / 5 s | account |
| Open positions | GET /equity/positions[?ticker=] | 1 req / 1 s | portfolio |
| Transactions (deposit/withdraw/fee/transfer) | GET /equity/history/transactions?cursor&time&limit | 6 req / 60 s | history:transactions |
| Dividends | GET /equity/history/dividends?cursor&ticker&limit | 6 req / 60 s | history:dividends |
| Orders (filled history) | GET /equity/history/orders?cursor&ticker&limit | 6 req / 60 s | history:orders |
| Request CSV export | POST /equity/history/exports | 1 req / 30 s | (unspecified) |
| List exports | GET /equity/history/exports | 1 req / 60 s | (unspecified) |
| Instruments metadata | GET /equity/metadata/instruments (~5 MB, cache 1h) | 1 req / 50 s | (unspecified) |
| Exchanges metadata | GET /equity/metadata/exchanges | 1 req / 30 s | (unspecified) |

Pending orders (`GET /equity/orders`, 1/5 s) and pies (deprecated) are out of scope. Rate limits are per ACCOUNT, not per key or IP. Every response carries `x-ratelimit-limit`, `x-ratelimit-period` (s), `x-ratelimit-remaining`, `x-ratelimit-reset` (unix s), `x-ratelimit-used`; bursts allowed; 429 on exceed [V-spec]. Honor `x-ratelimit-reset` on 429.

Pagination: `limit` default 20, max 50. Response `{items:[...], nextPagePath: string|null}`; follow the ENTIRE `nextPagePath` string as the next path (it already contains limit and cursor); null means end [V-spec]. Transactions: `cursor` is a string and must be used together with `time` (both come embedded in `nextPagePath`); orders/dividends use a numeric ms cursor [S-T2]. No date-range filter [S-T2]. Known bugs (single-source): later transaction pages may 404 "transaction not found" (reported Feb 2026, open), skipped blocks (fixed late 2025), non-chronological dividends [S-T2, S-T4 forum]. Mitigation: treat a 404 mid-pagination as "partial", keep what you have, and offer CSV export for a complete backfill. Exports: 403 on demo [S-T2, tested by that author Sep 2026]; async: POST returns `{reportId}`, poll list until `status` = Finished (statuses: Queued, Processing, Running, Canceled, Failed, Finished), then download `downloadLink` WITHOUT sending API credentials [V-spec; S-T2]. POST body `{dataIncluded:{includeDividends,includeInterest,includeOrders,includeTransactions}, timeFrom, timeTo}` (ISO date-times). CSV column layout is not in the spec [UNVERIFIED].

Errors: 400 bad filter, 401 bad key, 403 missing scope, 408 timeout, 429 limited [V-spec]. Bodies vary: RFC 7807 `{type,title,status,detail}`, legacy `{code,clarification}`, `{code,message}`, or empty/plain text [S-T2]. Branch on status only. Docs mark many numeric fields non-nullable but they can be null [S-T2]; parse defensively.

### 2.3 Response shapes [V-spec unless noted]

AccountSummary: `{id:int64, currency:"EUR"|..., totalValue:number, cash:{availableToTrade, inPies, reservedForOrders}, investments:{currentValue, totalCost, realizedProfitLoss, unrealizedProfitLoss}}`. All money values are JSON numbers (floats) in the account currency. Note there is no single "total cash" field: cash = availableToTrade + inPies + reservedForOrders [inference]. `totalValue` description says "Investments value" but is the account total [ambiguous; verify against live data: expect totalValue ~= cash sum + investments.currentValue].

Position: `{instrument:{ticker,name,isin,currency}, quantity, quantityAvailableForTrading, quantityInPies, averagePricePaid (instrument ccy), currentPrice (instrument ccy), createdAt, walletImpact:{currency, totalCost, currentValue, unrealizedProfitLoss, fxImpact}}`. `walletImpact.*` is in the account currency, `averagePricePaid`/`currentPrice` in the instrument currency (GBX = pence for UK instruments [S-T2]). Quantity can have 8 decimals.

HistoryTransactionItem: `{reference:string, type:"WITHDRAW"|"DEPOSIT"|"FEE"|"TRANSFER", amount:number, currency:string, dateTime:date-time}`. `amount` sign convention is NOT documented: check against live data whether WITHDRAW/FEE are negative; normalise by `type` (DEPOSIT +, WITHDRAW -, FEE -, TRANSFER: sign as given) [UNVERIFIED]. Spec calls it "superficial information": no description/counterparty text. Interest on cash is only in CSV export (`includeInterest`), not in this endpoint [inference from export flags].

HistoryDividendItem: `{reference, ticker, tickerCurrency, instrument{...}, quantity, grossAmountPerShare (instrument ccy), amount (account ccy, net paid), amountInEuro, currency (account ccy), paidOn:date-time, type: ORDINARY|BONUS|DIVIDEND|INTEREST|... (large enum incl. *_MANUFACTURED_PAYMENT)}`.

HistoricalOrder: `{order:{id:int64, ticker, instrument, side:BUY|SELL, type:MARKET|LIMIT|STOP|STOP_LIMIT, status:(FILLED,PARTIALLY_FILLED,CANCELLED,REJECTED,...), createdAt, currency, quantity?, value?, filledQuantity?, filledValue?, limitPrice?, stopPrice?, initiatedFrom, strategy, timeInForce, extendedHours}, fill:{id:int64, filledAt, price, quantity, type:TRADE|STOCK_SPLIT|SPIN_OFF|..., tradingMethod, walletImpact:{currency, netValue, fxRate, realisedProfitLoss, taxes:[{name:COMMISSION_TURNOVER|CURRENCY_CONVERSION_FEE|STAMP_DUTY|..., quantity, currency, chargedAt}]}}}`. `fill` may be null for unfilled orders. `walletImpact.netValue` is the cash effect in account currency (sign convention [UNVERIFIED]: expect negative for BUY).

### 2.4 Cash ledger completeness warning

The ledger that explains cash balance = deposits/withdrawals/fees/transfers (transactions) + order fills (`fill.walletImpact.netValue`) + dividends (`amount`) + interest (export only). Transactions endpoint alone will NOT reconcile to `cash`. Reconcile with `/summary` and show the diff as "unexplained".

---

## 3. Mapping to a common model

### 3.1 IngestRow

```ts
type IngestRow = {
  source: 'enablebanking' | 'trading212';
  accountRef: string;          // local account id (NOT the session-scoped EB uid)
  externalId: string;          // stable per source+account, see below
  bookingDate: string;         // YYYY-MM-DD, local date of booking
  valueDate: string | null;
  amount: bigint;              // signed MINOR units (cents); inflow > 0
  currency: string;            // ISO 4217
  description: string;
  counterparty: string | null;
  status: 'booked' | 'pending';
  kind?: string;               // optional: 'card','transfer','dividend','fee','deposit','trade',...
  raw: unknown;                // keep original JSON for reprocessing
};
```
Rules for both: dedupe key = `(source, accountRef, externalId)`; upsert so pending rows can be replaced by their booked version; never use floats for money (convert decimal strings/numbers via a decimal lib; minor-unit exponent from currency: 2 for EUR/GBP/USD, 0 for JPY, 3 for KWD etc.); store original `amount` text in `raw`.

### 3.2 Enable Banking transaction -> IngestRow

| IngestRow | Source |
|---|---|
| externalId | `entry_reference` ?? `transaction_id` ?? synthetic `syn_` + sha1(uid-independent account key, booking/value date, amount, indicator, normalized remittance, occurrence index). Prefix with which field was used (`ref:`, `tid:`, `syn:`) so a bank switching fields is detectable. Caution: some banks reuse or change `entry_reference` between PDNG and BOOK; keep pending rows in a separate namespace and delete them on each successful full-window refetch. |
| bookingDate | `booking_date` ?? `value_date` ?? `transaction_date` |
| valueDate | `value_date` |
| amount | `toMinor(transaction_amount.amount)`, negated if `credit_debit_indicator == "DBIT"` |
| currency | `transaction_amount.currency` |
| description | `remittance_information.join(" ")` ?? `note` ?? `bank_transaction_code.description` ?? `reference_number` |
| counterparty | DBIT: `creditor.name`; CRDT: `debtor.name` (null if absent) |
| status | `status == "BOOK"` -> booked, `PDNG` -> pending (other statuses CNCL/RJCT: drop; HOLD/SCHD/OTHR: treat as pending, [UNVERIFIED]) |

Sync strategy: on first link fetch with `strategy=longest` from a far `date_from`; thereafter incremental with `date_from = last_booking_date - 7 days` (overlap handles late-booked items) and rely on upsert. Respect the 4/day unattended budget (1.5). Account link: match new sessions' accounts to existing local accounts by IBAN or `identification_hash`, never by `uid`.

Balances: store snapshots `{accountRef, asOf, type: balance_type, amount minor, currency}` from `/balances`; pick display balance by preference ITAV > CLAV > ITBD > CLBD > first. Do not derive balance by summing transactions (history window is limited).

### 3.3 Trading 212 -> IngestRow (cash movements only)

Treat T212 as ONE cash account (currency = `summary.currency`) plus a positions book. Rows:

| T212 item | externalId | bookingDate / valueDate | amount (minor, signed) | description | counterparty | kind |
|---|---|---|---|---|---|---|
| transaction | `tx:` + `reference` | date of `dateTime` (use the user's timezone consistently) / same | `amount` signed per `type` (DEPOSIT +, WITHDRAW -, FEE -, TRANSFER as given) in `currency` | `type` + reference | null | deposit / withdrawal / fee / transfer |
| dividend | `div:` + `reference` | `paidOn` / same | `+amount` (account ccy, already net) | `Dividend <ticker> <type> qty x grossPerShare` | `instrument.name` | dividend |
| order fill | `ord:` + `order.id` + `:` + `fill.id` | `fill.filledAt` / same | `walletImpact.netValue` (account ccy; verify sign) | `BUY|SELL <qty> <ticker> @ <price>` | `instrument.name` | trade |
| fill taxes/fees | `fee:` + order.id + `:` + fill.id + `:` + tax.name | `tax.chargedAt` | `-tax.quantity` ONLY if netValue excludes fees [UNVERIFIED]; default: do not emit, assume netValue is net | tax name | null | fee |

All T212 rows are `status: booked`. `currency` is the account currency (use `walletImpact.currency`/`currency`, not instrument currency). Reference ids are strings; order ids int64 (store as string). If transactions pagination 404s, keep what was fetched and flag the account as "history incomplete" with a prompt to import the CSV export.

Sync cadence: daily is plenty. A full history walk costs ceil(N/50) calls at 6/min per history endpoint, so run the three history endpoints sequentially with a limiter that reads `x-ratelimit-remaining/reset`. Summary and positions: <= 1 call each per sync.

### 3.4 Balances and positions

- Cash balance snapshot (T212): `cash.availableToTrade + cash.inPies + cash.reservedForOrders`, currency `summary.currency`; also store `investments.currentValue` and `totalValue` for net worth. Keep the breakdown, since "available to trade" differs from "cash".
- Position snapshot table `{accountRef, asOf, instrumentTicker, isin, name, instrumentCurrency, quantity, avgPrice, price, valueAccountCcy = walletImpact.currentValue, costAccountCcy = walletImpact.totalCost, unrealizedPnl = walletImpact.unrealizedProfitLoss, fxImpact}`. Use ISIN as the cross-source key (tickers get renamed, see S-T2). Quantity as decimal string (8 dp). Replace-all per snapshot time; keep history for charts.
- Net worth = bank balances (EB) + T212 `totalValue`; mark T212 values with `asOf` since marked-to-market prices.

---

## 4. Open items to confirm against vendor docs before coding the edge cases

1. EB: exact 4xx/429 error codes and `Retry-After`, PSU header names, consent-expiry session status, what `/auth` rejects when `valid_until` > max, `code` TTL, callback error params, whether restricted production links per account or per ASPSP, exact sandbox ASPSP names/countries (look for "Mock ASPSP").
2. EB: whether `/accounts/{uid}/transactions` returns PDNG by default; whether `transaction_status` filter works for every bank.
3. T212: sign of `HistoryTransactionItem.amount` for WITHDRAW/FEE, sign of `fill.walletImpact.netValue`, whether it includes taxes, whether `totalValue` includes cash, whether legacy key-only auth and old `/equity/portfolio`, `/equity/account/cash` still respond, CSV export column layout, scope name for exports/instruments.
4. T212: the 404-on-later-pages transactions bug status in October 2026.
Quickest confirmation: run both vendors' sandboxes/demo with real keys and record fixtures into tests.
