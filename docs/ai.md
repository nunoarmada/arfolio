# AI features

AI in Arfolio is optional and off until you switch it on, in two steps:

1. A household **owner** adds an Anthropic API key to the installation: **Settings > Services > AI** (or the `ANTHROPIC_API_KEY` environment variable). Create the key in the Anthropic console; **Test API key** checks that it works. This is your own account with Anthropic, billed to you.
2. Each household decides for itself: an owner switches AI on in **Settings > Household**. Without the key the switch is off and says why.

With either step missing, nothing is ever sent to Anthropic.

The AI features:

| Feature                     | What it does                                                                                                         | Model setting (default)                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Categorisation              | Suggests a category for movements that your rules and the app's merchant memory left uncategorised.                  | `AI_CATEGORISATION_MODEL` (`claude-haiku-5-5`) |
| Merchant names and logos    | Works out the merchant's name, website and city from a movement's text, so lists show a name and a logo.            | the same categorisation model                  |
| Monthly report              | Writes a summary of the previous month with suggestions, in **Insights > Reports**.                                  | `AI_REPORT_MODEL` (`claude-opus-5-5`)          |
| Asset valuation             | Estimates the value of property, vehicles and other valuables once a month, from comparable listings found online.   | `AI_VALUATION_MODEL` (`claude-opus-5-5`)       |
| Statement import from PDF   | Reads the movements of a PDF statement in the import wizard, after a confirmation per file.                         | `AI_IMPORT_MODEL` (`claude-opus-5-5`)          |
| Financial advisor           | A chat assistant that answers questions about your spending, budget and goals, and proposes changes you apply yourself. | `AI_ADVISOR_MODEL` (the report model)          |

Models are set on **Settings > Services > AI** or with the environment variables shown. Use any model name your Anthropic account can access.

## What is sent

Everything is sent from your server straight to the Anthropic API. Arfolio has no server of its own in between. The sections below say what each feature sends. Most of them redact or aggregate first; the exceptions are the PDF statement import, which sends the file as it is, and the financial advisor, which sends the data the model asks for while it answers (see below).

### Categorisation

For each movement that needs a category:

- the description and the counterparty, **after redaction**: email addresses, IBANs, card numbers, phone numbers and any run of six or more digits are replaced by `#`. Short numbers stay, because they are part of merchant names ("Shop 123");
- the amount with its currency, and the month (not the day);
- the card network's merchant category (code and label) when the bank provides it;
- the household's category names, once per batch.

Never sent: account names, IBANs, account balances, notes, the names of household members. Only booked movements are sent. A run works through the waiting rows in passes of up to 500, at most 20 passes per run, and each row is sent at most three times.

One caveat: a movement's description can contain a merchant's or a person's name exactly as it appears on the statement. Redaction removes numbers and identifiers, not names. If that matters to you, leave AI off.

How it behaves: the answer is applied automatically, with a confidence. At 0.85 or more the movement leaves the review inbox; below that it stays in **To review** for you to confirm. A movement is tried at most three times; after that it gets the household's generic "other" category and is flagged for review. Switching AI off keeps the categories already applied. Your own edits always win over the AI. The text of a transaction is passed as data and the model is told never to follow instructions found in it.

### Merchant names and logos

With AI on, the worker also sends, per merchant, the redacted description and counterparty, the card network's merchant category, only the direction of the movement (money in or out, not the amount), the currency and a country hint. The answer (name, website, city) is stored.

Logos are then fetched from **Google's favicon service**, which receives the merchant's website address and nothing about you or your transactions. Set `MERCHANT_LOGOS=off` to switch that off; names still work.

### Monthly report

At the start of each month the worker builds a summary of the previous month and asks the report model for a short report. The summary holds aggregates only:

- totals for the month, the month before and the average of the three months before;
- the names and amounts of category groups and budget lines;
- recurring payments (by name only when you confirmed or renamed them, otherwise by category) and their monthly cost;
- net worth at the end of the month, at the start and its 12-month change;
- the month's anomalies, which include the day, category and amount of large movements.

Never the movement descriptions, notes, account names, IBANs or member names. A month's report can be generated again up to three times.

### Asset valuation

Valuation is a second opt-in. Each asset has its own switch (**Estimate the value automatically with AI** on the asset form) and needs its details filled in; the form lists what is still missing. Once a month the model searches the web, restricted to listing portals, and records an estimate with a range, a confidence and the listings it relied on. **Estimate now** on an asset requests one outside the monthly run.

Sent: the asset type, its details (for property only the municipality, parish and postal code, never a street address), the free-text description, the currency, today's date and the last three recorded values with how each was obtained. Not sent: the asset's name and notes, and anything about your accounts.

- Web search must be enabled for your Anthropic organisation (in the Anthropic console, under privacy settings), or valuations fail.
- **Valuation portals** (Settings > Services > Valuation portals) decide where the model may search. The defaults (`DEFAULT_VALUATION_PORTALS` in `packages/services/src/integration-config.ts`) are `idealista.pt`, `imovirtual.com`, `casa.sapo.pt` and `supercasa.pt` for property; `standvirtual.com`, `olx.pt`, `autoscout24.pt` and `custojusto.pt` for vehicles; `olx.pt` and `custojusto.pt` for other items. Boats and watches additionally use `standvirtual.com` and `chrono24.pt`; art and collectibles use a general web search. One host per line, up to 20 per list; replace the defaults with the portals of your country. **Use defaults** restores them.
- When the model finds too little to go on, the asset waits for the next month or for **Estimate now**. A failed call is retried after 12 hours.

### Statement import from PDF

In the import wizard, choosing a `.pdf` file on the first step offers to read it with AI. Nothing is sent until the person confirms it, in a notice shown for each file. The server checks every condition itself: the member can import, the installation has an API key, AI is on for the household, and the file was confirmed. Without all four the file never reaches Anthropic.

Sent: the whole PDF, **unredacted**, with a fixed instruction. Nothing else is added: no account names, categories, history or household details. The document is treated as data, and the model is given no tools.

**This is the one AI feature that sends personal data unredacted.** A statement can show the holder's name and address, account or card numbers and balances, and all of it goes to Anthropic. If that matters to you, leave AI off, or import the statement as CSV, XLSX, XLS or OFX instead.

The answer holds, for each movement, a date, a description and a signed amount, plus the statement's currency and the number of accounts whose movements the document lists. A card statement with several cards on one card account (a main card and additional cards) is read as one account. Every row is validated; an amount with more decimals than the account's currency has (for example cents on a JPY account) makes the row invalid. If a row is invalid, the answer was refused or cut short, the document lists movements of more than one account, or the currency differs from the account's (checked only when the statement states one), nothing is imported. A statement in which no movements are found imports nothing either. The preview shows every movement read from the PDF, not only the first rows, and only the movements the person confirms there are kept. The PDF and the model's answer are not stored, and the import history records the batch as a CSV named after the PDF (`<name>.pdf.csv`).

The preview is the usual one, with a line saying the rows were read by AI. Check them against the statement. Duplicates are detected and the import can be undone, as for any statement. If the amounts come out with the wrong sign, **Back** leads to the column step, where **Reverse the sign of the amounts** fixes them without sending the file again.

- **Limits:** 10 MB per file, about 200 movements per statement (split a longer one; the model has two minutes to answer), and 10 PDF statements per household per hour. Every attempt that passes the checks counts, including one that fails. The hourly count is kept in each web process, so with several replicas the limit applies to each one.
- **Time:** each statement is one request that can take up to two minutes. A reverse proxy with a shorter response timeout can cut a long statement off; see [Configuration](configuration.md#reverse-proxy-timeouts).
- **Model:** `AI_IMPORT_MODEL`, or **Settings > Services > AI**. A larger model reads layouts better and costs more.
- **Not supported:** password-protected PDFs, and the budget import wizard.

### Financial advisor

A chat assistant for each member: a floating button on every page opens a window (a sheet on phones), and the same conversation is on its own page at `/advisor`. It answers questions about spending, the budget, net worth and goals, and can **propose** a goal, a budget line amount, a categorisation rule or the category of a movement. Nothing is changed until a member presses **Apply**, with their own permissions, and every applied proposal is written to the audit log. Viewers can chat and read proposals but cannot apply them. The advisor never gives advice about specific investment products, answers in the household's language and currency, and is told to treat the text of movements as data, never as instructions.

**What it sends.** This feature sends more than aggregates: while it answers, the model asks for the data it needs and receives it. Everything goes from your server straight to Anthropic, and only for a member who writes in the chat, or when a proactive message is written (see below). Sent:

- the member's messages, and the recent part of their conversation;
- the results of the tools the model asks for: movement **descriptions and counterparties after redaction** (emails, IBANs, card numbers, phone numbers and runs of six or more digits replaced by `#`), amounts, dates, account names, institution names and balances, credit limits and amounts owed on credit accounts, categories, budget line and goal names;
- the spending profile (per category, the median and range of recent complete months, separating one-off from recurring spending) and the learning state;
- the household's goals and the advisor notes (below).

Names (of accounts, categories, budget lines and goals) are **not** redacted, and a movement's description can still contain a merchant's or a person's name. Never sent: IBANs and card numbers (redacted), movement notes (removed, and not searchable by the advisor), and other members' conversations. A proactive message sends the facts of the event that triggered it plus the same context. If that matters to you, leave AI off: with the household switch off, or no key, nothing is sent and the advisor is hidden.

**Notes.** The model can save short notes about what a member tells it ("I want to pay off the car loan first") so it does not have to reread the history. Notes are written by the model, are listed under **Notes** in the advisor menu, can be deleted there, and are sent back to the model in later conversations. Because the model reads movement text, a crafted description could try to influence a note: review the list now and then.

**Learning period.** Until the household has at least **3 complete calendar months** of booked movements on its active accounts (`ADVISOR_LEARNING_MONTHS`, 1 to 24), the advisor is still learning. The period is measured from the data, not from the day AI was switched on: an installation that imported a year of statements is ready at once. While learning, the advisor answers questions and helps set goals, but it does not propose budget amounts or a goal's monthly saving; a goal's own target amount is allowed, because it is the person's own number. Proposed budget amounts and monthly contributions show their basis (the months used, the range and the median), which the server computes from the data, not the model; a goal's target amount is the person's own number and has none. After the period, a category with too little history still gets no numeric proposal.

**Proactive messages.** The advisor can write first: a welcome message, one "what I have learned" message when the learning period ends, a monthly check-in, and short messages when a fixed rule notices something (a goal falling behind its pace, an unusual income, a new recurring payment, a budget line clearly going over). The rules run in code once a day, at 09:00 in the installation's time zone (`TZ`), not after each sync; the model is only called to write the message once one fires. A proactive message lands in the member's conversation and creates a notification (and a push, if that member enabled push) that opens `/advisor`. They start for a member only after that member has opened the advisor at least once (or has written to it), so the first message is never a surprise. Every member of a household with AI on receives them after that, viewers included, unless they switch them off in the advisor menu under **Settings**.

**Limits.** To protect your Anthropic bill:

- at most **2 proactive messages per member per week** (`ADVISOR_WEEKLY_CAP`, `0` to `14`); a member can lower it for themselves (never above the installation's value) or switch proactive messages off. The welcome and "what I have learned" messages do not count;
- at most **50 chat messages per member per day** (`ADVISOR_DAILY_MESSAGES`); proactive messages do not count. A clear message is shown when the limit is reached;
- at most **8 tool calls** while answering one message (`ADVISOR_MAX_TOOL_CALLS`, 1 to 20) and a cap on the length of each reply.

**Your data.**

- A conversation, its notes and proposals are private to the member who had it; other members and owners cannot see them.
- **Clear history** (advisor menu) deletes the member's conversation, notes and pending proposals. Changes already applied stay, with their audit entries, and goals stay because they are household data.
- Removing a member from the household deletes their advisor conversation, notes and proposals.
- Switching AI off for the household (or removing the key) hides the advisor and sends nothing. Its data is kept and comes back if AI is switched on again.

The model is set with `AI_ADVISOR_MODEL` or on **Settings > Services > AI**, like the others. Left unset in both places, the advisor uses the same model as the reports.

## Costs

You pay Anthropic for your own usage; Arfolio adds nothing. As a rough guide:

- **Categorisation** uses a small, fast model, in batches, with the instructions cached. It scales with the number of new movements that rules did not already categorise, and is usually cheap.
- **Reports** are one call per household per month (plus a regeneration if you ask), with a short input.
- **Valuations** are the heaviest: one call per asset per month, plus one for each **Estimate now**, each with a few web searches and page reads. Choose a smaller valuation model if the cost matters more than the quality.
- **PDF statements** are one call per file, with the whole document as input. Long statements with many pages cost the most.
- **The advisor** makes one call per chat message, plus one more for every tool the model uses while answering (up to `ADVISOR_MAX_TOOL_CALLS`), and one per proactive message. Unless you set its own model it uses the report model, a large one by default: the daily message limit and the weekly cap bound the cost, and a smaller model lowers it.

Token usage of the categorisation, merchant and report runs is written to the worker's log, so you can compare it with your Anthropic bill; for valuations use the usage view in the Anthropic console. Check Anthropic's current pricing for the models you choose.

## Turning it off

- A household owner switches **AI** off in **Settings > Household**: nothing more is sent for that household. Existing categories, reports and valuations stay, and the advisor is hidden with its conversations kept.
- Remove the key on the Services page (or unset `ANTHROPIC_API_KEY`) to switch AI off for the whole installation.
