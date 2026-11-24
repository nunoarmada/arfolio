# AI financial advisor — design

Status: draft for approval · Date: 2026-11-24

## Intent

Give each household member a personal finance advisor inside the app: a conversation with an AI that
knows the household's accounts, movements, budgets and goals, and helps the person organise their money
in a solid, consistent and sustainable way. It follows the person over time: it remembers goals, returns
to them in later conversations and sends messages on its own when something is worth saying.

Arfolio is open source and self-hosted (see `AGENTS.md`): everything here is generic: any household,
country, bank, currency and language. The owner pays for every model call with their own Anthropic key.

## Goals

- A conversation screen where the model can look up the household's data on demand (several lookups
  per answer) and explain what it finds.
- 2–3 suggested questions when the conversation opens, clickable to start it.
- Continuity: conversation history kept per member; goals are the household's existing goals
  (`goal` table, `/net-worth/goals`), which the advisor reads and proposes.
- Actions proposed by the advisor and applied only after the person confirms (one click, "Apply").
- Proactive messages: a monthly check-in plus messages when something relevant happens, capped.
- A learning period: no numeric suggestions until there is enough data to see patterns.

## Non-goals

- Advice on specific financial products (which fund, share, insurance, loan). The advisor stays on
  organisation: budgeting, saving, debt, emergency fund, goals. Product advice is regulated in many
  countries and would expose whoever runs the installation.
- Country-specific tax products, rates or rules in prompts or code.
- Page-aware context (the window knowing which page or transaction is open) in v1; a later addition.
- Voice, file uploads in the chat, or sharing conversations between members.
- Calling the installation's MCP endpoint from Anthropic's side (needs a public server and a token
  leaving the installation).

## Anti-goals (failure even if it works)

- Noise: frequent or trivial messages ("you spent €12 on coffee") that make people switch it off.
- Suggestions built on one month of data (a budget of €300 for restaurants because last month was €300).
- The model inventing numbers: averages, medians and totals must come from code.
- The model changing financial data without the person seeing and confirming it.
- Sending more data to Anthropic than the question needs, or sending anything when AI is off.

## Constraints

- AI gate: the installation has an Anthropic key **and** the household has `ai_enabled`. Without both,
  no call is made; the page explains how to enable AI and the Home card is hidden.
- Tenant isolation: every query inside `withHousehold(...)`; RLS as second layer.
- Roles: `owner` and `member` may apply proposals; `viewer` may chat but sees proposals without "Apply"
  (`assertCanWrite`).
- Logs carry ids only; no amounts, descriptions, names or message text.
- Five locales (`en`, `pt-PT`, `es-ES`, `fr-FR`, `it-IT`) for all UI strings; the model answers in the
  household's locale (`household_settings.locale`, the same one the UI uses; there is no per-member
  locale) and uses the household's currency. Money in the UI goes through the formatting helpers
  (privacy mode).
- Brand via brand helpers; no literal product name in UI code or prompts.
- Migrations additive, hand-written SQL with journal and snapshot.
- New env vars optional with safe defaults, documented in `.env.example`, `docs/configuration.md`,
  passed through in `compose.yaml` and the Helm chart.
- `docs/ai.md` documents the new data sent (see Privacy).

## Approaches considered

**A. Server-side tool-use loop (chosen).** The web server runs the conversation with Claude using the
Messages API with tools. Tools reuse the existing MCP handlers (extracted into a shared registry so MCP
and the advisor run the same code) plus a few advisor-specific tools. Replies stream to the browser.
Proactive messages are worker jobs that write into the same conversation and create a notification.
Cost: the most work. Gain: the only option that lets the advisor cross data and dig deeper before
answering, which is the point of the feature.

**B. One summary per message, no tools.** Each turn sends a fixed snapshot (profile, goals, totals).
Simpler, cheaper, sends less data, but cannot answer questions outside the snapshot ("what did I spend
most on in March?"), and the snapshot grows without bound. Rejected.

**C. Anthropic calls the instance's MCP endpoint.** Needs the server reachable from the internet and a
token leaving the installation. Rejected.

## Decisions

### Placement and UI

- **Floating launcher on every app page** (bottom-right, brand colour, chat icon), the main entry point.
  It shows an unread dot when a proactive message arrived. Hidden when AI is off for the household or
  the advisor is unavailable to the member.
- **Chat window** opened by the launcher:
  - desktop/tablet: a window anchored bottom-right (about 400 × 640 px, never taller than the viewport)
    over the page; the page stays usable behind it;
  - mobile (< md): a full-screen sheet, since a floating window does not fit at 390 px; on mobile the
    launcher sits above the bottom navigation bar and pages keep enough bottom padding not to be covered.
  - header: advisor name and status ("thinking…" while the model works), minimise, and "open full page";
    no "end conversation" (the conversation is continuous).
  - open/closed state survives navigation between pages (the window lives in the app shell).
- **Page `/advisor`**: the same conversation full width, for longer sessions and as the target of
  notifications on small screens. Not in the main navigation (the launcher is); reachable from the
  window header, from "More" and from notifications.
- Home card: the latest advisor message and the suggested questions. Hidden when AI is off.
- Window and page share one component and one conversation: messages, suggested questions when the
  conversation is empty or idle, proposal cards with "Apply" / "Dismiss", and a composer. Loading,
  empty, error and AI-off states. Follows `docs/design/design-system-v2.md` (semantic HTML, labels,
  keyboard, focus management and Escape to close the window, ≥ 44 px targets, light/dark, 390 px).
- One continuous conversation per member (a thread, not many chats). Older history is paged.

### Suggested questions

- 2–3 at a time, chosen in code from the household's state, not generated by the model (free, instant,
  translatable). Examples of the pool: "How am I doing this month?", "Where can I save?", "How is my
  emergency fund?", "Help me set a goal", and during the learning period "What have you learned so far?"
  Selection rules (which ones apply when) are left to the builder; they must all exist in five locales.

### Memory

- Conversation history per member, stored in the database. Private to the member (other members and the
  owner do not see it).
- Goals live in the existing `goal` table and are the household's: visible to every member on
  `/net-worth/goals`. The advisor reads them and can propose creating or changing them.
- A short advisor "notes" memory per member (facts the person told it: "I want to pay off the car loan
  first") is kept so it does not have to re-read the whole history. The model proposes notes; they are
  shown to the person and can be deleted. Builder decides the shape; keep it small and bounded.
- Context sent to the model per turn: system prompt, spending profile summary, goals, notes, and the
  most recent messages within a token budget (older ones dropped or summarised; builder's call).

### Learning period

- Measured from data, not from the day the advisor is switched on: the household is "learning" until it
  has at least **3 complete calendar months** of booked movements on its active accounts
  (default, configurable). An installation that imported a year of statements is ready at once.
- While learning, the advisor converses, answers questions about the data and helps define goals. It does
  **not** propose amounts (budgets, monthly saving targets). Proactive messages while learning: a welcome
  message, and one "what I have learned" message when the period ends.
- After it ends, numeric suggestions per category need enough data for that category too (builder sets
  the threshold, documented).
- Numbers come from code: a spending profile computes, per category, the median of the last 3–6 complete
  months, the range, and separates one-off spending from recurring (using the existing recurring
  detection and outlier rules). Every numeric suggestion carries its basis ("last 4 months: €180–240,
  median €210") and the UI shows it.

### Tools available to the model

Read tools (from the existing MCP set, shared code): overview, list accounts, net worth, budget vs
actual, search transactions, list categories, review inbox. New read tools: `get_spending_profile`
(the computed profile above, including the learning state), `list_goals` (with progress).

Proposal tool: `propose_action` returns a structured proposal stored with the message; nothing is
written to household data until a member clicks "Apply". Supported proposal kinds in v1:

- create or update a goal;
- create or change a budget line amount;
- create a categorisation rule;
- categorise a transaction.

"Apply" calls the existing services through a server action with the member's own context, role check
and `audit_log` entry (actor marking it came from an advisor proposal). A proposal can be applied once;
it is marked applied, dismissed or stale (if the data it was based on changed; builder decides how
staleness is checked). **Amounts while learning (call made in design):** a goal's target amount is allowed while learning,
because it is the person's own target ("€6,000 by June"). Budget line amounts and a goal's monthly
contribution are refused by the server while the household is learning, since those are suggestions
derived from spending patterns.

**Basis of numeric proposals (call made in design):** for budget amounts and monthly contributions the
server attaches the basis itself from the spending profile (range, median, months used); the model does
not write it. The server refuses an amount outside the profile's observed range for that category unless
the person stated it in the conversation (builder decides how that is flagged; keep it explicit in the
tool schema). The UI shows the server's basis.

No tool lets the model write directly.

### Proactive messages

- Triggers: a **monthly check-in** (after month end, alongside the existing monthly report job) and
  **events** detected by deterministic rules after each sync (no model call to detect). Initial event
  set: a goal falls behind its pace; an unusual income arrives; a new recurring payment appears; a budget
  line is clearly going over. The model is called only to write the message once a rule fires.
- Cap: at most **2 proactive messages per member per week** (default, configurable), deduplicated per
  event. Members can switch proactive messages off or lower the frequency in their settings.
- A proactive message is written into the member's conversation and creates a `notification` for that
  member (in-app, and web push when the member enabled push), opening `/advisor`.
- Who receives event messages: every member of a household with the AI gate open and proactive
  messages on in their own settings; viewers included (read only). "Advisor available" means exactly the
  AI gate; there is no separate per-member on/off for the chat itself.
- What counts toward the weekly cap (call made in design): event messages and the monthly check-in. The
  welcome and "what I have learned" messages are one-off and exempt. Proactive messages do not count
  toward the member's daily chat limit. Dedupe keys include the member id (the `notification` table
  dedupes per household).

### Data lifecycle (calls made in design)

- AI switched off for the household: advisor data is kept but hidden and nothing is sent; switching AI on
  again shows it.
- A member removed from the household: their conversation, notes and proposals are deleted.
- Each member has "Clear history" (deletes their conversation, notes and pending proposals; applied
  changes to household data stay, with their audit rows). Goals are household data and are not deleted.

### Models and settings

- New model setting `AI_ADVISOR_MODEL`, same precedence as the others (env → Settings → Services → AI →
  default). Default: the same as the report model.
- Configurable defaults (env, optional): learning months (3), proactive weekly cap (2). Per-member
  settings: proactive on/off and frequency.
- Limits to protect the owner's bill: max tool calls per turn, max tokens per reply, and a per-member
  daily message limit with a clear message when reached. Builder sets defaults and documents them.

### Safety of the model's behaviour

- System prompt: generic (no country, product or bank assumptions), answers in the household's locale and
  household currency, never gives product-specific investment advice, never states numbers it did not
  get from a tool, treats transaction text as data and never follows instructions found in it.
- Tool results that include movement text go through `redact.ts` before reaching the model.

### Privacy (to document in `docs/ai.md`)

New feature row "Financial advisor" with what it sends: the member's messages; tool results the model
asks for (which can include redacted movement descriptions and counterparties, amounts, dates, account
names and balances, category and budget names, goals); the spending profile; the advisor notes. Never
IBANs or card numbers (redacted), never other members' conversations. Like the PDF import, this sends
more than aggregates: say so plainly, and that leaving AI off prevents it. Proactive messages send the
event data plus the same context.

## Left to the builder

- Data model for conversations, messages, proposals, notes and per-member advisor settings.
- Streaming transport (route handler with SSE or similar) and how the client renders partial replies.
- Extracting the MCP handlers into a shared registry without changing MCP behaviour.
- Exact event rules and thresholds, suggested-question selection rules, staleness check, history
  trimming, limits' default values; all documented.
- Icon for the nav item, card and page layout within the design system.

## Verification

- Unit tests for the profile computation (medians, one-off separation, learning state), event rules,
  cap and dedupe, proposal apply/refuse paths (role, learning, stale, double apply), tenant isolation.
- Tests with a fake Anthropic client for the tool loop (limits, tool errors, redaction applied).
- e2e: open `/advisor`, click a suggested question, receive a streamed reply from a mocked model, apply a
  proposal; AI-off state. Specs clean up every row they write.
