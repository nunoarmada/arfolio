import type { Db } from '@arfolio/db';
import { integrationEnvShape, isHttpsOrLoopbackUrl } from '@arfolio/core';
import { readInstanceSettings, type InstanceSettingKey } from './instance-settings.js';

export type ConfigSource = 'env' | 'db' | 'default' | 'unset';

export type Resolved<T> = {
  value: T | undefined;
  source: ConfigSource;
  /** A stored value exists but cannot be decrypted with the current ENCRYPTION_KEY. */
  unreadable: boolean;
  /** A stored value exists but fails validation; it is ignored. */
  invalid: boolean;
  /** When the stored (DB) value was last written, if there is one. */
  updatedAt?: Date;
};

export type ValuationPortals = { property: string[]; vehicle: string[]; classifieds: string[] };

export type IntegrationConfig = {
  anthropicApiKey: Resolved<string>;
  models: {
    categorisation: Resolved<string>;
    report: Resolved<string>;
    valuation: Resolved<string>;
  };
  valuationPortals: Resolved<ValuationPortals>;
  enableBanking: {
    appId: Resolved<string>;
    privateKey: Resolved<string>;
    apiUrl: Resolved<string>;
  };
  smtpUrl: Resolved<string>;
  mailFrom: Resolved<string>;
};

/** The raw environment (`process.env`-shaped). */
export type IntegrationEnvInput = Record<string, string | undefined>;

export const DEFAULT_VALUATION_PORTALS: ValuationPortals = {
  property: ['idealista.pt', 'imovirtual.com', 'casa.sapo.pt', 'supercasa.pt'],
  vehicle: ['standvirtual.com', 'olx.pt', 'autoscout24.pt', 'custojusto.pt'],
  classifieds: ['olx.pt', 'custojusto.pt'],
};

const HOSTNAME = /^([a-z0-9-]+\.)+[a-z]{2,}$/;
const MAX_PORTALS_PER_LIST = 20;

type Parsed<T> = { ok: true; value: T } | { ok: false };

/** Validates a raw string with one of the env field schemas, so env and DB share the same rules. */
const fromEnvSchema =
  (schema: { safeParse(input: unknown): { success: boolean; data?: unknown } }) =>
  (raw: string): Parsed<string> => {
    const r = schema.safeParse(raw);
    return r.success && typeof r.data === 'string' ? { ok: true, value: r.data } : { ok: false };
  };

/** A model name: non-empty, no whitespace anywhere (on top of the env field rules). */
const modelName =
  (schema: Parameters<typeof fromEnvSchema>[0]) =>
  (raw: string): Parsed<string> =>
    raw === '' || /\s/.test(raw) ? { ok: false } : fromEnvSchema(schema)(raw);

const nonEmpty = (raw: string): Parsed<string> =>
  raw.trim() === '' ? { ok: false } : { ok: true, value: raw };

/**
 * An SMTP connection URL: `smtp:` or `smtps:` only, with a host, and no query string or fragment.
 * Nodemailer reads query parameters of a connection URL as transport options (another transport,
 * weaker TLS), so they are never accepted. Applies to env, stored and newly saved values alike.
 */
function parseSmtpUrl(raw: string): Parsed<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false };
  }
  if (!['smtp:', 'smtps:'].includes(url.protocol)) return { ok: false };
  if (
    url.hostname === '' ||
    url.search !== '' ||
    url.hash !== '' ||
    raw.includes('?') ||
    raw.includes('#')
  ) {
    return { ok: false };
  }
  try {
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
  } catch {
    return { ok: false };
  }
  return { ok: true, value: raw };
}

/** Connect, greeting and socket timeouts of the SMTP transport, so a dead server cannot hang a request. */
export const SMTP_TIMEOUT_MS = 10_000;

export type SmtpTransportOptions = {
  host: string;
  port: number;
  secure: boolean;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  auth?: { user: string; pass: string };
};

/**
 * Explicit transport options for a validated SMTP URL, so the raw string never reaches
 * `createTransport`. Throws on a value `parseSmtpUrl` would reject.
 */
export function smtpTransportOptions(raw: string): SmtpTransportOptions {
  if (!parseSmtpUrl(raw).ok) throw new Error('Invalid SMTP URL');
  const url = new URL(raw);
  const secure = url.protocol === 'smtps:';
  const options: SmtpTransportOptions = {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port !== '' ? Number(url.port) : secure ? 465 : 587,
    secure,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  };
  if (url.username !== '' || url.password !== '') {
    options.auth = {
      user: decodeURIComponent(url.username),
      pass: decodeURIComponent(url.password),
    };
  }
  return options;
}

let smtpEnvLogged = false;

const apiUrlFromEnvRules = fromEnvSchema(integrationEnvShape.ENABLE_BANKING_API_URL);
/** DB-entered URLs are held to the strict rule (https or loopback) whatever NODE_ENV is. */
const parseApiUrl = (raw: string): Parsed<string> =>
  isHttpsOrLoopbackUrl(raw) ? apiUrlFromEnvRules(raw) : { ok: false };

function parsePortals(raw: string): Parsed<ValuationPortals> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (typeof json !== 'object' || json === null) return { ok: false };
  const out: Partial<ValuationPortals> = {};
  for (const list of ['property', 'vehicle', 'classifieds'] as const) {
    const hosts = (json as Record<string, unknown>)[list];
    if (
      !Array.isArray(hosts) ||
      hosts.length > MAX_PORTALS_PER_LIST ||
      !hosts.every((h): h is string => typeof h === 'string' && HOSTNAME.test(h))
    ) {
      return { ok: false };
    }
    out[list] = hosts;
  }
  return { ok: true, value: out as ValuationPortals };
}

/** Schema default of an env field (parsing "nothing"), the single source of default values. */
const schemaDefault = (schema: { parse(input: unknown): unknown }): string =>
  schema.parse(undefined) as string;

type Spec<T> = {
  envVar?: string;
  dbKey: InstanceSettingKey;
  parse: (raw: string) => Parsed<T>;
  defaultValue?: T;
};

type Stored = Awaited<ReturnType<typeof readInstanceSettings>>;

/**
 * env > DB > default. An env value counts only when the variable is present and non-empty. Raw
 * env values are assumed valid: startup env parsing (`parseEnv`) already rejects invalid ones, so
 * a value failing here is ignored rather than reported. DB values that are unreadable or fail
 * validation are treated as unset and flagged.
 */
function resolveOne<T>(spec: Spec<T>, env: IntegrationEnvInput, stored: Stored): Resolved<T> {
  const row = stored[spec.dbKey];
  const meta: Pick<Resolved<T>, 'unreadable' | 'invalid' | 'updatedAt'> = {
    unreadable: false,
    invalid: false,
    ...(row ? { updatedAt: row.updatedAt } : {}),
  };

  const rawEnv = spec.envVar ? env[spec.envVar] : undefined;
  if (rawEnv !== undefined && rawEnv !== '') {
    const parsed = spec.parse(rawEnv);
    if (parsed.ok) return { value: parsed.value, source: 'env', ...meta };
    if (spec.envVar === 'SMTP_URL' && !smtpEnvLogged) {
      smtpEnvLogged = true;
      console.error(
        'SMTP_URL is not a valid smtp:// or smtps:// URL without query string; ignored',
      );
    }
  }

  if (row) {
    if ('unreadable' in row) {
      meta.unreadable = true;
    } else if (row.value !== '') {
      const parsed = spec.parse(row.value);
      if (parsed.ok) return { value: parsed.value, source: 'db', ...meta };
      meta.invalid = true;
    }
  }

  return spec.defaultValue === undefined
    ? { value: undefined, source: 'unset', ...meta }
    : { value: spec.defaultValue, source: 'default', ...meta };
}

const SPECS = {
  anthropicApiKey: {
    envVar: 'ANTHROPIC_API_KEY',
    dbKey: 'anthropic.apiKey',
    parse: fromEnvSchema(integrationEnvShape.ANTHROPIC_API_KEY),
  },
  categorisation: {
    envVar: 'AI_CATEGORISATION_MODEL',
    dbKey: 'ai.categorisationModel',
    parse: modelName(integrationEnvShape.AI_CATEGORISATION_MODEL),
    defaultValue: schemaDefault(integrationEnvShape.AI_CATEGORISATION_MODEL),
  },
  report: {
    envVar: 'AI_REPORT_MODEL',
    dbKey: 'ai.reportModel',
    parse: modelName(integrationEnvShape.AI_REPORT_MODEL),
    defaultValue: schemaDefault(integrationEnvShape.AI_REPORT_MODEL),
  },
  valuation: {
    envVar: 'AI_VALUATION_MODEL',
    dbKey: 'ai.valuationModel',
    parse: modelName(integrationEnvShape.AI_VALUATION_MODEL),
    defaultValue: schemaDefault(integrationEnvShape.AI_VALUATION_MODEL),
  },
  valuationPortals: {
    dbKey: 'ai.valuationPortals',
    parse: parsePortals,
    defaultValue: DEFAULT_VALUATION_PORTALS,
  },
  appId: {
    envVar: 'ENABLE_BANKING_APP_ID',
    dbKey: 'enableBanking.appId',
    parse: fromEnvSchema(integrationEnvShape.ENABLE_BANKING_APP_ID),
  },
  privateKey: {
    envVar: 'ENABLE_BANKING_PRIVATE_KEY',
    dbKey: 'enableBanking.privateKey',
    parse: fromEnvSchema(integrationEnvShape.ENABLE_BANKING_PRIVATE_KEY),
  },
  apiUrl: {
    envVar: 'ENABLE_BANKING_API_URL',
    dbKey: 'enableBanking.apiUrl',
    parse: parseApiUrl,
    defaultValue: schemaDefault(integrationEnvShape.ENABLE_BANKING_API_URL),
  },
  smtpUrl: { envVar: 'SMTP_URL', dbKey: 'smtp.url', parse: parseSmtpUrl },
  mailFrom: { envVar: 'MAIL_FROM', dbKey: 'mail.from', parse: nonEmpty },
} satisfies Record<string, Spec<unknown>>;

const PARSE_BY_KEY = new Map<InstanceSettingKey, (raw: string) => Parsed<unknown>>(
  Object.values(SPECS).map((spec) => [spec.dbKey, spec.parse]),
);

/**
 * Checks a value about to be stored for `key` with the very rules the resolver applies when it
 * reads it back, so what is saved is always usable. Returns the value to store (an env-style
 * rule may normalise it: a PEM with literal `\n` gets real newlines; portals come back as the
 * canonical JSON).
 */
export function parseInstanceSetting(
  key: InstanceSettingKey,
  raw: string,
): { ok: true; value: string } | { ok: false } {
  const parsed = PARSE_BY_KEY.get(key)?.(raw);
  if (!parsed?.ok) return { ok: false };
  return {
    ok: true,
    value: typeof parsed.value === 'string' ? parsed.value : JSON.stringify(parsed.value),
  };
}

/** The one place that decides each integration setting: env var, else stored value, else default. */
export async function resolveIntegrationConfig(
  db: Db,
  encKey: Buffer,
  env: IntegrationEnvInput,
): Promise<IntegrationConfig> {
  const stored = await readInstanceSettings(db, encKey);
  const one = <T>(spec: Spec<T>) => resolveOne(spec, env, stored);
  return {
    anthropicApiKey: one(SPECS.anthropicApiKey),
    models: {
      categorisation: one(SPECS.categorisation),
      report: one(SPECS.report),
      valuation: one(SPECS.valuation),
    },
    valuationPortals: one(SPECS.valuationPortals),
    enableBanking: {
      appId: one(SPECS.appId),
      privateKey: one(SPECS.privateKey),
      apiUrl: one(SPECS.apiUrl),
    },
    smtpUrl: one(SPECS.smtpUrl),
    mailFrom: one(SPECS.mailFrom),
  };
}

/**
 * Caches the resolved config for `ttlMs`. Concurrent `get()` calls share one in-flight load, a
 * rejected load is never cached, and `invalidate()` also discards a load already in flight.
 */
export function createIntegrationConfigCache(
  load: () => Promise<IntegrationConfig>,
  ttlMs: number,
): { get(): Promise<IntegrationConfig>; invalidate(): void } {
  let entry: { promise: Promise<IntegrationConfig>; expiresAt: number } | undefined;
  return {
    get() {
      const now = Date.now();
      if (entry && entry.expiresAt > now) return entry.promise;
      const promise = load();
      const mine = { promise, expiresAt: now + ttlMs };
      entry = mine;
      promise.catch(() => {
        if (entry === mine) entry = undefined;
      });
      return promise;
    },
    invalidate() {
      entry = undefined;
    },
  };
}

/** AI features need the installation's Anthropic API key (households still opt in). */
export const isAiAvailable = (cfg: IntegrationConfig): boolean =>
  cfg.anthropicApiKey.value !== undefined;

/** Bank connections need the Enable Banking app id and private key. */
export const isBankingConfigured = (cfg: IntegrationConfig): boolean =>
  cfg.enableBanking.appId.value !== undefined && cfg.enableBanking.privateKey.value !== undefined;
