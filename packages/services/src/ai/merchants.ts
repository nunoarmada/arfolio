import { and, asc, desc, eq, inArray, isNull, lt, not, sql } from 'drizzle-orm';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { mccLabel, merchantKey, parseTransactionDetails } from '@arfolio/core';
import { schema, withHousehold, type Tx } from '@arfolio/db';
import {
  errorLabel,
  isStopError,
  type AiCategoriseDeps,
  type AiParseResult,
} from './categorise.js';
import {
  buildMerchantSystemBlocks,
  buildMerchantUserMessage,
  merchantOutputSchema,
  type MerchantPromptRow,
} from './prompt.js';
import { redactForAi } from './redact.js';
import { mergeDetailsSql } from '../details-sql.js';
import { awaitingT212Export } from '../t212-pending.js';

const { householdSettings, merchant, transaction } = schema;

/** Merchants per model call. */
export const MERCHANT_BATCH_SIZE = 50;
/** Rows per run, which bounds the cost of one run (the hourly sweep picks up the rest). */
export const MERCHANT_MAX_ROWS_PER_RUN = 300;
/** A row is sent at most this many times; one the model never answers properly then stays unmarked. */
export const MERCHANT_MAX_ATTEMPTS = 3;
const MAX_OUTPUT_TOKENS = 8_192;

/** Same dependencies as categorisation: the AI switch, the key and the model are shared. */
export type AiMerchantsDeps = AiCategoriseDeps;

export type AiMerchantsResult = {
  status: 'done' | 'disabled' | 'no_api_key' | 'rate_limited';
  /** Merchants created or updated. */
  merchants: number;
  /** Rows marked as looked at (with or without a merchant). */
  rows: number;
  inputTokens: number;
  outputTokens: number;
};

const EMPTY: Omit<AiMerchantsResult, 'status'> = {
  merchants: 0,
  rows: 0,
  inputTokens: 0,
  outputTokens: 0,
};

const itemSchema = merchantOutputSchema.shape.items.element;

const HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const IP_LIKE = /^\d+(\.\d+)+$/;
const NAME_MAX = 60;
const CITY_MAX = 100;

type Candidate = {
  id: string;
  rawDescription: string;
  counterparty: string | null;
  amount: number;
  currency: string;
  mcc: string | null;
  details: unknown;
};

type Group = { key: string; rows: Candidate[] };

type Decision = {
  name: string | null;
  domain: string | null;
  location: { city?: string; country?: string } | null;
};

/** A plain lower-case hostname, or null (schemes, paths, ports, IPs and odd characters fail). */
function cleanDomain(raw: string | null): string | null {
  const domain = raw?.trim().toLowerCase();
  if (!domain || domain.length > 253 || !HOSTNAME.test(domain) || IP_LIKE.test(domain)) return null;
  return domain;
}

function cleanText(raw: string | null, max: number): string | null {
  const text = raw?.replace(/\s+/g, ' ').trim().slice(0, max);
  return text || null;
}

const URL_LIKE = /:\/\/|^www\./i;
const HOSTNAME_TOKEN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
/** Seven or more digits, however they are spaced or punctuated: a phone number or an identifier. */
const PHONE_LIKE = /\+?\d(?:[\s().-]?\d){6,}/g;

/**
 * The model's name is untrusted text that ends up on screen: URLs, hostnames and phone-like digit
 * runs are removed, spaces collapsed and the length capped. Null when nothing is left.
 */
function cleanName(raw: string | null): string | null {
  if (!raw) return null;
  const kept = raw
    .replace(PHONE_LIKE, ' ')
    .split(/\s+/)
    .filter((token) => {
      const bare = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      return !URL_LIKE.test(token) && !HOSTNAME_TOKEN.test(bare);
    });
  return cleanText(kept.join(' '), NAME_MAX);
}

/** Lower-case letters only, diacritics folded; everything else becomes a space. */
function letters(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

/** "pingodoce" for pingodoce.pt or www.pingodoce.pt, "tesco" for tesco.co.uk. */
function registrableLabel(domain: string): string {
  const labels = domain.split('.');
  const sld = labels.at(-2)!;
  return labels.length >= 3 && SECOND_LEVEL.has(sld) ? labels.at(-3)! : sld;
}

/**
 * A domain is only believed when its main label shares four consecutive letters with the name.
 * A short brand (a label under four letters, "ctt.pt") has no such run, so it is accepted when
 * the label is the whole name or one of its words.
 */
function domainFitsName(domain: string, name: string): boolean {
  const haystack = letters(name);
  const label = letters(registrableLabel(domain));
  if (
    label.length > 0 &&
    label.length < 4 &&
    haystack.split(' ').concat(haystack.replaceAll(' ', '')).includes(label)
  ) {
    return true;
  }
  for (const run of label.split(' ')) {
    for (let i = 0; i + 4 <= run.length; i += 1) {
      if (haystack.includes(run.slice(i, i + 4))) return true;
    }
  }
  return false;
}

/** Outflows and rows with a merchant category code look like payments to a business. */
function looksLikeMerchantPayment(group: Group): boolean {
  return group.rows.some((r) => r.amount < 0 || r.mcc !== null);
}

function toDecision(item: z.output<typeof itemSchema>, group: Group): Decision {
  if (item.isPerson) return { name: null, domain: null, location: null };
  const city = cleanText(item.city, CITY_MAX);
  const country =
    item.country && /^[A-Za-z]{2}$/.test(item.country.trim())
      ? item.country.trim().toUpperCase()
      : null;
  const location = city || country ? { ...(city && { city }), ...(country && { country }) } : null;
  // Money received from a private party is not a merchant, whatever the model says.
  if (!looksLikeMerchantPayment(group)) return { name: null, domain: null, location };
  const name = cleanName(item.merchant);
  const domain = cleanDomain(item.domain);
  return {
    name,
    domain: name && domain && domainFitsName(domain, name) ? domain : null,
    location,
  };
}

/** The country of the counterparty's IBAN, or of a location the provider already gave. */
function countryHint(details: unknown): string | null {
  const parsed = parseTransactionDetails(details);
  const iban = parsed?.counterpartyAccount?.iban?.replace(/\s+/g, '');
  const fromIban = iban && /^[A-Za-z]{2}\d{2}/.test(iban) ? iban.slice(0, 2).toUpperCase() : null;
  return parsed?.location?.country ?? fromIban;
}

async function loadCandidates(deps: AiMerchantsDeps, householdId: string) {
  const maxRows = deps.maxRowsPerRun ?? MERCHANT_MAX_ROWS_PER_RUN;
  return withHousehold(deps.db, householdId, async (tx) => {
    const [settings] = await tx
      .select({ aiEnabled: householdSettings.aiEnabled })
      .from(householdSettings)
      .where(eq(householdSettings.householdId, householdId));
    if (!settings?.aiEnabled) return null;
    const rows: Candidate[] = await tx
      .select({
        id: transaction.id,
        rawDescription: transaction.rawDescription,
        counterparty: transaction.counterparty,
        amount: transaction.amount,
        currency: transaction.currency,
        mcc: transaction.mcc,
        details: transaction.details,
      })
      .from(transaction)
      .where(
        and(
          eq(transaction.householdId, householdId),
          eq(transaction.status, 'booked'),
          isNull(transaction.merchantEnrichedAt),
          lt(transaction.merchantEnrichAttempts, MERCHANT_MAX_ATTEMPTS),
          // A card row the Trading 212 export has yet to name would be judged blind.
          not(awaitingT212Export(householdId)),
        ),
      )
      .orderBy(desc(transaction.bookingDate), asc(transaction.id))
      .limit(maxRows);
    return rows;
  });
}

/** Rows of one merchant key share the answer; groups keep the newest-first order of the rows. */
function groupByKey(rows: Candidate[]): { groups: Group[]; keyless: string[] } {
  const byKey = new Map<string, Group>();
  const keyless: string[] = [];
  for (const row of rows) {
    const key = merchantKey(row.rawDescription, row.counterparty);
    if (!key) {
      keyless.push(row.id);
      continue;
    }
    const group = byKey.get(key);
    if (group) group.rows.push(row);
    else byKey.set(key, { key, rows: [row] });
  }
  return { groups: [...byKey.values()], keyless };
}

function toPromptRow(ref: string, row: Candidate): MerchantPromptRow {
  const counterparty = row.counterparty ? redactForAi(row.counterparty) : '';
  return {
    id: ref,
    description: redactForAi(row.rawDescription),
    counterparty: counterparty || null,
    mcc: row.mcc,
    mccLabel: mccLabel(row.mcc, 'en') ?? null,
    direction: row.amount < 0 ? 'out' : 'in',
    currency: row.currency,
    countryHint: countryHint(row.details),
  };
}

/** Drops unknown ids, duplicate answers (the first wins) and malformed items. */
function readDecisions(parsed: unknown, refToGroup: Map<string, Group>): Map<string, Decision> {
  const out = new Map<string, Decision>();
  const list = z.object({ items: z.array(z.unknown()) }).safeParse(parsed);
  if (!list.success) return out;
  for (const raw of list.data.items) {
    const item = itemSchema.safeParse(raw);
    if (!item.success) continue;
    const group = refToGroup.get(item.data.id);
    if (!group || out.has(group.key)) continue;
    out.set(group.key, toDecision(item.data, group));
  }
  return out;
}

/**
 * Creates the merchant, or updates the one with this key. A name set by the user is never
 * replaced; the domain only fills a gap.
 */
async function upsertMerchant(
  tx: Tx,
  householdId: string,
  key: string,
  name: string,
  domain: string | null,
): Promise<string> {
  const [row] = await tx
    .insert(merchant)
    .values({
      householdId,
      key,
      displayName: name,
      nameSource: 'ai',
      domain,
      enrichedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [merchant.householdId, merchant.key],
      set: {
        displayName: sql`case when ${merchant.nameSource} = 'user' then ${merchant.displayName} else excluded.display_name end`,
        nameSource: sql`case when ${merchant.nameSource} = 'user' then 'user' else 'ai' end`,
        domain: sql`coalesce(${merchant.domain}, excluded.domain)`,
        enrichedAt: sql`now()`,
      },
    })
    .returning({ id: merchant.id });
  return row!.id;
}

/**
 * Writes one batch: merchants, links, locations and the "looked at" mark, all in one
 * transaction. A link is only set where there is none, and a location the provider gave wins.
 */
async function applyBatch(
  deps: AiMerchantsDeps,
  householdId: string,
  batch: Group[],
  decisions: Map<string, Decision>,
): Promise<{ merchants: number; rows: number }> {
  return withHousehold(deps.db, householdId, async (tx) => {
    let merchants = 0;
    let rows = 0;
    for (const group of batch) {
      const decision = decisions.get(group.key);
      // No usable answer: the row stays unmarked and is asked again until the attempts run out.
      if (!decision) continue;
      const merchantId = decision.name
        ? await upsertMerchant(tx, householdId, group.key, decision.name, decision.domain)
        : null;
      if (merchantId) merchants += 1;
      const updated = await tx
        .update(transaction)
        .set({
          merchantEnrichedAt: sql`now()`,
          ...(merchantId && {
            merchantId: sql`coalesce(${transaction.merchantId}, ${merchantId}::uuid)`,
          }),
        })
        .where(
          and(
            eq(transaction.householdId, householdId),
            inArray(
              transaction.id,
              group.rows.map((r) => r.id),
            ),
          ),
        )
        .returning({ id: transaction.id });
      if (decision.location) {
        for (const row of group.rows) {
          // A location the provider gave wins over the guess; the size cap lives in the helper.
          const existing = parseTransactionDetails(row.details)?.location;
          const location = { ...decision.location, ...existing };
          if (JSON.stringify(location) === JSON.stringify(existing)) continue;
          await tx
            .update(transaction)
            .set({ details: mergeDetailsSql(transaction.details, { location }) })
            .where(and(eq(transaction.householdId, householdId), eq(transaction.id, row.id)));
        }
      }
      rows += updated.length;
    }
    return { merchants, rows };
  });
}

/** Counted before the call, so a crash or timeout still uses up an attempt. */
async function countAttempt(deps: AiMerchantsDeps, householdId: string, batch: Group[]) {
  const ids = batch.flatMap((g) => g.rows.map((r) => r.id));
  await withHousehold(deps.db, householdId, (tx) =>
    tx
      .update(transaction)
      .set({ merchantEnrichAttempts: sql`${transaction.merchantEnrichAttempts} + 1` })
      .where(and(eq(transaction.householdId, householdId), inArray(transaction.id, ids))),
  );
}

/** Rows with no usable key cannot name a merchant: they are only marked as looked at. */
async function markLooked(deps: AiMerchantsDeps, householdId: string, ids: string[]) {
  if (ids.length === 0) return 0;
  return withHousehold(deps.db, householdId, async (tx) => {
    const updated = await tx
      .update(transaction)
      .set({ merchantEnrichedAt: sql`now()` })
      .where(and(eq(transaction.householdId, householdId), inArray(transaction.id, ids)))
      .returning({ id: transaction.id });
    return updated.length;
  });
}

/**
 * Asks the model for the friendly name, website and place of the household's booked rows that
 * the merchant pass has not looked at yet (newest first, one question per merchant key). Runs
 * only when the household has AI on and the installation has an API key. A batch that fails or
 * comes back unusable is logged and left for the next run; a 429 or 5xx ends the run.
 */
export async function enrichMerchants(
  deps: AiMerchantsDeps,
  input: { householdId: string },
): Promise<AiMerchantsResult> {
  const { anthropic, logger } = deps;
  if (!anthropic) return { status: 'no_api_key', ...EMPTY };
  const candidates = await loadCandidates(deps, input.householdId);
  if (!candidates) return { status: 'disabled', ...EMPTY };
  const result: AiMerchantsResult = { status: 'done', ...EMPTY };
  if (candidates.length === 0) return result;

  const { groups, keyless } = groupByKey(candidates);
  result.rows += await markLooked(deps, input.householdId, keyless);
  const system = buildMerchantSystemBlocks();
  const size = Math.min(deps.batchSize ?? MERCHANT_BATCH_SIZE, MERCHANT_BATCH_SIZE);
  const batches: Group[][] = [];
  for (let i = 0; i < groups.length; i += size) batches.push(groups.slice(i, i + size));

  for (const [n, batch] of batches.entries()) {
    const refToGroup = new Map<string, Group>();
    const rows = batch.map((g, i) => {
      const ref = `m${i + 1}`;
      refToGroup.set(ref, g);
      return toPromptRow(ref, g.rows[0]!);
    });
    await countAttempt(deps, input.householdId, batch);
    let response: AiParseResult;
    try {
      response = await anthropic.messages.parse({
        model: deps.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        messages: [{ role: 'user', content: buildMerchantUserMessage(rows) }],
        output_config: { format: zodOutputFormat(merchantOutputSchema) },
      });
    } catch (err) {
      if (isStopError(err)) {
        logger.warn(`ai merchants stopped at batch ${n + 1}/${batches.length}: ${errorLabel(err)}`);
        result.status = 'rate_limited';
        break;
      }
      logger.warn(`ai merchants batch ${n + 1}/${batches.length} failed: ${errorLabel(err)}`);
      continue;
    }
    result.inputTokens += response.usage.input_tokens;
    result.outputTokens += response.usage.output_tokens;
    if (response.stop_reason === 'refusal' || response.parsed_output == null) {
      logger.warn(
        `ai merchants batch ${n + 1}/${batches.length} unusable (${response.stop_reason ?? 'no output'})`,
      );
      continue;
    }
    const counts = await applyBatch(
      deps,
      input.householdId,
      batch,
      readDecisions(response.parsed_output, refToGroup),
    );
    result.merchants += counts.merchants;
    result.rows += counts.rows;
  }
  logger.info(
    `ai merchants: ${result.merchants} merchants, ${result.rows} rows, ` +
      `${result.inputTokens} input and ${result.outputTokens} output tokens`,
  );
  return result;
}
