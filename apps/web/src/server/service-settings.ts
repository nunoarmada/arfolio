import { z } from 'zod';
import nodemailer from 'nodemailer';
import {
  createEnableBankingClient,
  isUsableEnableBankingKey,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  type Aspsp,
} from '@arfolio/connectors';
import { schema, withHousehold, type Db } from '@arfolio/db';
import {
  ConflictError,
  deleteInstanceSetting,
  parseInstanceSetting,
  pingAnthropic,
  recordAudit,
  resolveIntegrationConfig,
  SECRET_KEYS,
  smtpTransportOptions,
  type SmtpTransportOptions,
  ValidationError,
  writeInstanceSetting,
  type AnthropicPingResult,
  type InstanceSettingKey,
  type IntegrationConfig,
  type IntegrationEnvInput,
  type Resolved,
  type ServiceCtx,
} from '@arfolio/services';
import { desc } from 'drizzle-orm';
import { CALLBACK_PATH } from './connector-deps';
import { requireMember } from './session';

/** The settings the Services page manages, in the order the page shows them. */
export const SERVICE_KEYS = [
  'anthropic.apiKey',
  'ai.categorisationModel',
  'ai.reportModel',
  'ai.valuationModel',
  'ai.valuationPortals',
  'enableBanking.appId',
  'enableBanking.privateKey',
  'enableBanking.apiUrl',
  'smtp.url',
  'mail.from',
] as const satisfies readonly InstanceSettingKey[];

/**
 * What the browser gets for one setting. `value` is present only for settings that are not
 * secrets; a secret is never sent back, only whether one is configured.
 */
export interface FieldView {
  key: InstanceSettingKey;
  source: Resolved<unknown>['source'];
  /** An environment variable or a stored value is in effect (a default does not count). */
  configured: boolean;
  /** A stored value exists but cannot be decrypted with the current ENCRYPTION_KEY. */
  unreadable: boolean;
  /** A stored value exists but fails validation and is ignored. */
  invalid: boolean;
  /** ISO time of the last stored write. */
  updatedAt?: string;
  value?: string;
}

export interface ServicesView {
  fields: Record<InstanceSettingKey, FieldView>;
  /** Where the bank sends people back to after consent: to register with Enable Banking. */
  callbackUrl: string;
}

export type ServiceName = 'anthropic' | 'enableBanking' | 'smtp';

/**
 * Stable codes the page turns into text in the user's language. Provider and SDK messages are
 * never forwarded: they can quote credentials.
 */
export type TestMessage =
  | 'ok'
  | 'not_configured'
  | 'invalid_key'
  | 'rejected'
  | 'rate_limited'
  | 'unreachable'
  | 'unavailable'
  | 'mail_sent'
  | 'verify_failed'
  | 'send_failed';

export interface TestOutcome {
  ok: boolean;
  message: TestMessage;
}

interface SmtpTransport {
  verify(): Promise<unknown>;
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

interface BankClient {
  listAspsps(country: string): Promise<Aspsp[]>;
}

export interface ServiceSettingsDeps {
  db: Db;
  encryptionKey: Buffer;
  /** The raw environment: an environment variable wins over anything stored. */
  env: IntegrationEnvInput;
  appUrl: string;
  brandName: string;
  /** Test seams; the defaults are the real clients. */
  ping?: (apiKey: string) => Promise<AnthropicPingResult>;
  createBankClient?: (config: {
    appId: string;
    privateKeyPem: string;
    baseUrl: string;
  }) => BankClient;
  createTransport?: (options: SmtpTransportOptions) => SmtpTransport;
  /** Receives the session so tests can use their own auth instance. */
  session?: Parameters<typeof requireMember>[2];
}

const resolveNow = (deps: ServiceSettingsDeps): Promise<IntegrationConfig> =>
  resolveIntegrationConfig(deps.db, deps.encryptionKey, deps.env);

const MAX_VALUE_LENGTH = 20_000;
const saveInput = z.strictObject({
  key: z.enum(SERVICE_KEYS),
  value: z.string().max(MAX_VALUE_LENGTH),
});
const removeInput = z.strictObject({ key: z.enum(SERVICE_KEYS) });
const testInput = z.strictObject({ service: z.enum(['anthropic', 'enableBanking', 'smtp']) });

function resolvedFor(cfg: IntegrationConfig, key: InstanceSettingKey): Resolved<unknown> {
  switch (key) {
    case 'anthropic.apiKey':
      return cfg.anthropicApiKey;
    case 'ai.categorisationModel':
      return cfg.models.categorisation;
    case 'ai.reportModel':
      return cfg.models.report;
    case 'ai.valuationModel':
      return cfg.models.valuation;
    case 'ai.valuationPortals':
      return cfg.valuationPortals;
    case 'enableBanking.appId':
      return cfg.enableBanking.appId;
    case 'enableBanking.privateKey':
      return cfg.enableBanking.privateKey;
    case 'enableBanking.apiUrl':
      return cfg.enableBanking.apiUrl;
    case 'smtp.url':
      return cfg.smtpUrl;
    case 'mail.from':
      return cfg.mailFrom;
  }
}

function fieldView(cfg: IntegrationConfig, key: InstanceSettingKey): FieldView {
  const r = resolvedFor(cfg, key);
  const view: FieldView = {
    key,
    source: r.source,
    configured: r.source === 'env' || r.source === 'db',
    unreadable: r.unreadable,
    invalid: r.invalid,
  };
  if (r.updatedAt) view.updatedAt = r.updatedAt.toISOString();
  if (!SECRET_KEYS.has(key) && r.value !== undefined) {
    view.value = typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
  }
  return view;
}

/** The view model for the page: the owner only; secrets reduced to "configured". */
export async function loadServicesView(
  headers: Headers,
  deps: ServiceSettingsDeps,
): Promise<ServicesView> {
  await requireMember(headers, { roles: ['owner'] }, deps.session);
  const cfg = await resolveNow(deps);
  return {
    fields: Object.fromEntries(SERVICE_KEYS.map((key) => [key, fieldView(cfg, key)])) as Record<
      InstanceSettingKey,
      FieldView
    >,
    callbackUrl: new URL(CALLBACK_PATH, deps.appUrl).toString(),
  };
}

async function ownerCtx(
  headers: Headers,
  deps: ServiceSettingsDeps,
): Promise<{ ctx: ServiceCtx; email: string }> {
  const session = await requireMember(
    headers,
    { roles: ['owner'], onDenied: 'forbidden', fresh: true },
    deps.session,
  );
  return {
    ctx: {
      db: deps.db,
      householdId: session.householdId,
      userId: session.user.id,
      role: session.role,
    },
    email: session.user.email,
  };
}

function invalidValue(key: InstanceSettingKey): ValidationError {
  // The message and issues carry the key name only, never the rejected value.
  return new ValidationError('Invalid setting value', [{ path: [key], message: 'invalid' }]);
}

/**
 * Stores one setting (encrypted) and audits it by key name. Rejected: not the owner, a setting an
 * environment variable controls, an empty or invalid value (the same rules the resolver applies).
 * The caller drops its cached config afterwards.
 */
export async function saveSetting(
  headers: Headers,
  input: unknown,
  deps: ServiceSettingsDeps,
): Promise<null> {
  const { ctx } = await ownerCtx(headers, deps);
  const parsed = saveInput.safeParse(input);
  if (!parsed.success) throw new ValidationError('Invalid input', []);
  const { key } = parsed.data;
  if (resolvedFor(await resolveNow(deps), key).source === 'env') {
    throw new ConflictError('set_by_environment', 'Set by an environment variable');
  }
  const raw = parsed.data.value.trim();
  // The env-style rules read an empty value as "unset" (and a model as its default): to go back
  // to the default the owner removes the stored value, so an empty save is a mistake.
  if (raw === '') throw invalidValue(key);
  const checked = parseInstanceSetting(key, raw);
  if (!checked.ok) throw invalidValue(key);
  if (key === 'enableBanking.privateKey' && !isUsableEnableBankingKey(checked.value)) {
    throw invalidValue(key);
  }
  await withHousehold(deps.db, ctx.householdId, async (tx) => {
    await writeInstanceSetting(tx, deps.encryptionKey, key, checked.value, ctx.userId);
    await recordAudit(tx, ctx, {
      actor: 'web',
      action: 'instance_setting.update',
      targetType: 'instance_setting',
      targetId: key,
    });
  });
  return null;
}

/** Deletes the stored value, so the setting falls back to its default (or to unset). */
export async function removeSetting(
  headers: Headers,
  input: unknown,
  deps: ServiceSettingsDeps,
): Promise<null> {
  const { ctx } = await ownerCtx(headers, deps);
  const parsed = removeInput.safeParse(input);
  if (!parsed.success) throw new ValidationError('Invalid input', []);
  const { key } = parsed.data;
  if (resolvedFor(await resolveNow(deps), key).source === 'env') {
    throw new ConflictError('set_by_environment', 'Set by an environment variable');
  }
  await withHousehold(deps.db, ctx.householdId, async (tx) => {
    await deleteInstanceSetting(tx, key);
    await recordAudit(tx, ctx, {
      actor: 'web',
      action: 'instance_setting.remove',
      targetType: 'instance_setting',
      targetId: key,
    });
  });
  return null;
}

const fail = (message: TestMessage): TestOutcome => ({ ok: false, message });

async function testAnthropic(cfg: IntegrationConfig, deps: ServiceSettingsDeps) {
  const apiKey = cfg.anthropicApiKey.value;
  if (apiKey === undefined) return fail('not_configured');
  const result = await (deps.ping ?? pingAnthropic)(apiKey);
  return result.ok ? { ok: true, message: 'ok' as const } : fail(result.reason);
}

/** The country of the household's latest bank consent, else Finland (a country Enable Banking lists). */
async function bankCountry(ctx: ServiceCtx): Promise<string> {
  const [row] = await withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select({ country: schema.consentState.aspspCountry })
      .from(schema.consentState)
      .orderBy(desc(schema.consentState.createdAt))
      .limit(1),
  );
  return row && /^[A-Z]{2}$/.test(row.country) ? row.country : 'FI';
}

async function testEnableBanking(
  cfg: IntegrationConfig,
  ctx: ServiceCtx,
  deps: ServiceSettingsDeps,
): Promise<TestOutcome> {
  const { appId, privateKey, apiUrl } = cfg.enableBanking;
  if (appId.value === undefined || privateKey.value === undefined || apiUrl.value === undefined) {
    return fail('not_configured');
  }
  if (!isUsableEnableBankingKey(privateKey.value)) return fail('invalid_key');
  const client = (deps.createBankClient ?? createEnableBankingClient)({
    appId: appId.value,
    privateKeyPem: privateKey.value,
    baseUrl: apiUrl.value,
  });
  try {
    await client.listAspsps(await bankCountry(ctx));
    return { ok: true, message: 'ok' };
  } catch (error) {
    if (error instanceof ProviderAuthError) return fail('rejected');
    if (error instanceof ProviderRateLimitError) return fail('rate_limited');
    if (error instanceof ProviderUnavailableError) return fail('unreachable');
    return fail('unavailable');
  }
}

async function testSmtp(
  cfg: IntegrationConfig,
  deps: ServiceSettingsDeps,
  ownerEmail: string,
): Promise<TestOutcome> {
  const url = cfg.smtpUrl.value;
  if (url === undefined) return fail('not_configured');
  let transport: SmtpTransport;
  try {
    transport = (deps.createTransport ?? ((o) => nodemailer.createTransport(o)))(
      smtpTransportOptions(url),
    );
    await transport.verify();
  } catch {
    return fail('verify_failed');
  }
  try {
    await transport.sendMail({
      from: cfg.mailFrom.value ?? `${deps.brandName} <no-reply@localhost>`,
      to: ownerEmail,
      subject: `${deps.brandName}: test email`,
      text: `This is a test email from ${deps.brandName}. Your email settings work.`,
    });
    return { ok: true, message: 'mail_sent' };
  } catch {
    return fail('send_failed');
  }
}

/**
 * Tries a service with the settings in effect now, independently of any unsaved edit. Sends no
 * household data. Outcomes are fixed codes, never provider or SDK text.
 */
export async function runServiceTest(
  headers: Headers,
  input: unknown,
  deps: ServiceSettingsDeps,
): Promise<TestOutcome> {
  const { ctx, email } = await ownerCtx(headers, deps);
  const parsed = testInput.safeParse(input);
  if (!parsed.success) throw new ValidationError('Invalid input', []);
  const cfg = await resolveNow(deps);
  switch (parsed.data.service) {
    case 'anthropic':
      return testAnthropic(cfg, deps);
    case 'enableBanking':
      return testEnableBanking(cfg, ctx, deps);
    case 'smtp':
      return testSmtp(cfg, deps, email);
  }
}
