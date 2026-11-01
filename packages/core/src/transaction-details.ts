import { z } from 'zod';

/** Upper bound, in UTF-8 bytes, for the serialised `details` JSON stored on a transaction. */
export const TRANSACTION_DETAILS_MAX_BYTES = 6_000;
const MAX_REMITTANCE_LINES = 10;
const MAX_REMITTANCE_LINE = 500;

/** ISO 18245 merchant category code: exactly four digits. */
export function isValidMcc(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}$/.test(value);
}

// Every field is best-effort: an invalid value is dropped (`catch`), never an error, so one odd
// field cannot block a row. Unknown keys are stripped by `z.object`.
// NUL is stripped: Postgres jsonb rejects \u0000 and one bad value would abort the whole ingest.
const stripNul = (s: string) => s.replaceAll('\u0000', '');

const text = (max: number) =>
  z
    .string()
    .transform((s) => stripNul(s).trim().slice(0, max))
    .pipe(z.string().min(1))
    .optional()
    .catch(undefined);

const minor = z
  .object({
    amount: z.number().int().safe(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .optional()
  .catch(undefined);

/** A sub-object that collapses to undefined when none of its fields survived. */
const group = <S extends z.ZodRawShape>(shape: S) =>
  z
    .object(shape)
    .transform((v) => (Object.values(v).some((x) => x !== undefined) ? v : undefined))
    .optional()
    .catch(undefined);

const remittance = z
  .array(z.unknown())
  .transform((lines) =>
    lines
      .map((l) => (typeof l === 'string' ? stripNul(l).trim().slice(0, MAX_REMITTANCE_LINE) : ''))
      .filter((l) => l !== '')
      .slice(0, MAX_REMITTANCE_LINES),
  )
  .pipe(z.array(z.string()).min(1))
  .optional()
  .catch(undefined);

/**
 * Everything a provider tells us about one transaction beyond the typed columns. All fields are
 * optional; `location` is filled by the AI enrichment, the rest by the connectors.
 */
export const transactionDetailsSchema = z.object({
  remittance,
  note: text(1_000),
  reference: text(200),
  entryReference: text(200),
  bankCode: group({ code: text(100), subCode: text(100), description: text(300) }),
  counterpartyAccount: group({ iban: text(64), other: text(100), bic: text(32) }),
  /** Minor units of `currency`; only set when it differs from the account currency. */
  originalAmount: minor,
  exchangeRate: text(40),
  balanceAfter: minor,
  providerType: text(100),
  merchantCategory: text(200),
  instrument: group({
    ticker: text(60),
    name: text(200),
    isin: text(20),
    quantity: text(40),
    pricePerShare: text(40),
  }),
  location: group({
    city: text(100),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional()
      .catch(undefined),
  }),
});

export type TransactionDetails = z.output<typeof transactionDetailsSchema>;

const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** Free-text fields go first when the object is over the size bound. */
const SHED_ORDER = ['remittance', 'note', 'bankCode', 'instrument'] as const;

/**
 * Validates untrusted `details`: unknown keys and invalid fields are dropped, never thrown on.
 * Returns undefined when nothing usable is left. The result fits `TRANSACTION_DETAILS_MAX_BYTES`.
 */
export function parseTransactionDetails(raw: unknown): TransactionDetails | undefined {
  const parsed = transactionDetailsSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(parsed.data).filter(([, v]) => v !== undefined),
  );
  for (const key of SHED_ORDER) {
    if (jsonBytes(out) <= TRANSACTION_DETAILS_MAX_BYTES) break;
    delete out[key];
  }
  if (Object.keys(out).length === 0 || jsonBytes(out) > TRANSACTION_DETAILS_MAX_BYTES) {
    return undefined;
  }
  return out as TransactionDetails;
}
