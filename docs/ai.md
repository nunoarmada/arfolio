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

Models are set on **Settings > Services > AI** or with the environment variables shown. Use any model name your Anthropic account can access.

## What is sent

Everything is sent from your server straight to the Anthropic API. Arfolio has no server of its own in between. The sections below say what each feature sends. Most of them redact or aggregate first; the exception is the PDF statement import, which sends the file as it is.

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

The answer holds, for each movement, a date, a description and a signed amount, plus the statement's currency and the number of accounts or cards whose movements the document lists. Every row is validated. If a row is invalid, the answer was refused or cut short, the document lists movements of more than one account or card, or the currency differs from the account's (checked only when the statement states one), nothing is imported. A statement in which no movements are found imports nothing either. The preview shows every movement read from the PDF, not only the first rows, and only the movements the person confirms there are kept. The PDF and the model's answer are not stored, and the import history records the batch as a CSV named after the PDF (`<name>.pdf.csv`).

The preview is the usual one, with a line saying the rows were read by AI. Check them against the statement. Duplicates are detected and the import can be undone, as for any statement. If the amounts come out with the wrong sign, **Back** leads to the column step, where **Invert the sign of every amount** fixes them without sending the file again.

- **Limits:** 10 MB per file, about 200 movements per statement (split a longer one; the model has two minutes to answer), and 10 PDF statements per household per hour. Every attempt that passes the checks counts, including one that fails. The hourly count is kept in each web process, so with several replicas the limit applies to each one.
- **Time:** each statement is one request that can take up to two minutes. A reverse proxy with a shorter response timeout can cut a long statement off; see [Configuration](configuration.md#reverse-proxy-timeouts).
- **Model:** `AI_IMPORT_MODEL`, or **Settings > Services > AI**. A larger model reads layouts better and costs more.
- **Not supported:** password-protected PDFs, and the budget import wizard.

## Costs

You pay Anthropic for your own usage; Arfolio adds nothing. As a rough guide:

- **Categorisation** uses a small, fast model, in batches, with the instructions cached. It scales with the number of new movements that rules did not already categorise, and is usually cheap.
- **Reports** are one call per household per month (plus a regeneration if you ask), with a short input.
- **Valuations** are the heaviest: one call per asset per month, plus one for each **Estimate now**, each with a few web searches and page reads. Choose a smaller valuation model if the cost matters more than the quality.
- **PDF statements** are one call per file, with the whole document as input. Long statements with many pages cost the most.

Token usage of the categorisation, merchant and report runs is written to the worker's log, so you can compare it with your Anthropic bill; for valuations use the usage view in the Anthropic console. Check Anthropic's current pricing for the models you choose.

## Turning it off

- A household owner switches **AI** off in **Settings > Household**: nothing more is sent for that household. Existing categories, reports and valuations stay.
- Remove the key on the Services page (or unset `ANTHROPIC_API_KEY`) to switch AI off for the whole installation.
