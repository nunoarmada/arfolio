import { redactForAi } from '@arfolio/services';

/** Free-text fields that can carry personal data: still shown to the model, but redacted. */
const REDACTED_KEYS = new Set(['description', 'counterparty', 'merchant_raw', 'raw_text']);
/** Fields the model never needs: dropped from tool output. */
const REMOVED_KEYS = new Set(['notes', 'iban', 'account_number']);

const MAX_CHARS = 20_000;
const TRUNCATED = '…[truncated: ask a narrower question]';

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk);
  if (value === null || typeof value !== 'object') return value;
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return walk((value as { toJSON: () => unknown }).toJSON());
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (REMOVED_KEYS.has(key)) continue;
    out[key] =
      REDACTED_KEYS.has(key) && typeof inner === 'string' ? redactForAi(inner) : walk(inner);
  }
  return out;
}

/**
 * What a tool result looks like when it is handed to the model: personal data redacted or removed
 * (see the key lists above), serialised, and cut to a size the conversation can afford.
 */
export function sanitiseToolOutput(value: unknown): string {
  const json = JSON.stringify(walk(value)) ?? 'null';
  return json.length > MAX_CHARS ? `${json.slice(0, MAX_CHARS)}${TRUNCATED}` : json;
}
