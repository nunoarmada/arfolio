import { z } from 'zod';

/** Thrown when environment variables fail validation. Lists keys only, never values. */
export class EnvError extends Error {
  readonly keys: readonly string[];

  constructor(keys: readonly string[]) {
    super(`Invalid or missing environment variables: ${keys.join(', ')}`);
    this.name = 'EnvError';
    this.keys = keys;
  }
}

export function parseEnv<T extends z.ZodTypeAny>(
  schema: T,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  const keys = [
    ...new Set(result.error.issues.map((i) => i.path.map(String).join('.') || '(root)')),
  ];
  throw new EnvError(keys);
}

/** ENCRYPTION_KEY format: 32 bytes as 64 hex chars. Lives here (client-safe); crypto.ts reuses it. */
export const ENCRYPTION_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** https always; plain http only for loopback hosts (any NODE_ENV). */
export function isHttpsOrLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** https always; plain http only outside production or for loopback hosts. */
function isSafeBrokerUrl(value: string): boolean {
  if (isHttpsOrLoopbackUrl(value)) return true;
  try {
    return new URL(value).protocol === 'http:' && process.env.NODE_ENV !== 'production';
  } catch {
    return false;
  }
}

/** Empty strings (an unset secret key rendered as `VAR=`) count as unset, so defaults apply. */
const emptyAsUnset = (value: unknown) => (value === '' ? undefined : value);

/**
 * Integration settings shared by web and worker. ENCRYPTION_KEY is always present in a
 * deployment; the Enable Banking and AI settings are optional (features hide when absent).
 */
export const integrationEnvShape = {
  /** 32 bytes as 64 hex chars (see `loadEncryptionKey`). */
  ENCRYPTION_KEY: z.string().regex(ENCRYPTION_KEY_PATTERN, 'expected 64 hex characters'),
  ENABLE_BANKING_APP_ID: z.preprocess(emptyAsUnset, z.string().min(1).optional()),
  /** PEM; secret stores often deliver it with literal `\n` sequences, normalised to newlines. */
  ENABLE_BANKING_PRIVATE_KEY: z.preprocess(
    emptyAsUnset,
    z
      .string()
      .min(1)
      .transform((pem) => pem.replace(/\\n/g, '\n'))
      .optional(),
  ),
  /** Same rule as TRADING212_API_URL: https in production, plain http only for loopback hosts. */
  ENABLE_BANKING_API_URL: z.preprocess(
    emptyAsUnset,
    z
      .url()
      .refine(isSafeBrokerUrl, 'expected an https URL (http only for loopback hosts)')
      .default('https://api.enablebanking.com'),
  ),
  /**
   * Trading 212 API base URL; only tests point it elsewhere (a key belongs to the live API). In
   * production it must be https, except for loopback hosts (the e2e fake broker).
   */
  TRADING212_API_URL: z.preprocess(
    emptyAsUnset,
    z
      .url()
      .refine(isSafeBrokerUrl, 'expected an https URL (http only for loopback hosts)')
      .default('https://live.trading212.com/api/v0'),
  ),
  ANTHROPIC_API_KEY: z.preprocess(emptyAsUnset, z.string().min(1).optional()),
  /**
   * Web Push (VAPID) identity. Optional: without them the app generates a key pair once and keeps
   * it in the database. Env wins only when BOTH keys are set (see `refineIntegrationEnv`).
   * Public key: base64url of the 65-byte uncompressed P-256 point; private: base64url of 32 bytes.
   */
  VAPID_PUBLIC_KEY: z.preprocess(
    emptyAsUnset,
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{87}$/)
      .optional(),
  ),
  VAPID_PRIVATE_KEY: z.preprocess(
    emptyAsUnset,
    z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .optional(),
  ),
  /** `mailto:` or `https:` contact for push services; defaults to an https APP_URL where known. */
  VAPID_SUBJECT: z.preprocess(
    emptyAsUnset,
    z
      .string()
      .refine(
        (v) => /^mailto:.+@.+/.test(v) || /^https:\/\/.+/.test(v),
        'expected mailto: or https:',
      )
      .optional(),
  ),
  /**
   * Extra push-service host suffixes beyond the built-in browser services (FCM, Mozilla, WNS,
   * APNs), comma separated, for self-hosted push (e.g. UnifiedPush): `push.example.org` also
   * allows its subdomains. Every entry is a plain DNS name with at least two labels.
   */
  PUSH_ALLOWED_HOSTS: z.preprocess(
    emptyAsUnset,
    z
      .string()
      .transform((list) =>
        list
          .split(',')
          .map((h) => h.trim().toLowerCase())
          .filter((h) => h !== ''),
      )
      .refine(
        (hosts) => hosts.every((h) => /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(h)),
        'expected comma-separated host names such as push.example.org',
      )
      .optional(),
  ),
  AI_CATEGORISATION_MODEL: z.preprocess(
    emptyAsUnset,
    z.string().min(1).default('claude-haiku-5-5'),
  ),
  /** The model that writes the monthly AI report (a bigger one than categorisation). */
  AI_REPORT_MODEL: z.preprocess(emptyAsUnset, z.string().min(1).default('claude-opus-5-5')),
  /** The model that estimates asset values (web research, so a bigger one). */
  AI_VALUATION_MODEL: z.preprocess(emptyAsUnset, z.string().min(1).default('claude-opus-5-5')),
  /**
   * Merchant logos: `on` (default) lets the worker fetch each merchant's favicon from Google's
   * favicon service (it sends the merchant's domain there); `off` disables fetching entirely.
   */
  MERCHANT_LOGOS: z.preprocess(emptyAsUnset, z.enum(['on', 'off']).default('on')),
};

/**
 * Cross-field rule for `integrationEnvShape`, applied by web and worker with `.superRefine`:
 * the VAPID keys are a pair, so setting exactly one is a startup error (never a silent fallback).
 */
export function refineIntegrationEnv(
  env: { VAPID_PUBLIC_KEY?: string | undefined; VAPID_PRIVATE_KEY?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  const hasPublic = env.VAPID_PUBLIC_KEY !== undefined;
  if (hasPublic !== (env.VAPID_PRIVATE_KEY !== undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: [hasPublic ? 'VAPID_PRIVATE_KEY' : 'VAPID_PUBLIC_KEY'],
      message: 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together',
    });
  }
}
