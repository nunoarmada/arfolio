import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, withHousehold } from '@arfolio/db';
import { isAiAvailable, type IntegrationConfig } from '@arfolio/services';
import { LOCALES } from '../i18n/locales';
import { getDb } from '../lib/db';
import { nameSchema } from '../lib/credentials';
import { getIntegrationConfig } from './integration-config';
import { requireMember, type SessionDeps } from './session';
import { getAuth } from '../lib/auth';

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isCurrency(value: string): boolean {
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: value });
    return true;
  } catch {
    return false;
  }
}

export const householdSettingsSchema = z.object({
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .refine(isCurrency),
  locale: z.enum(LOCALES),
  timezone: z.string().min(1).max(64).refine(isTimeZone),
  fiscalYearStartMonth: z.number().int().min(1).max(12),
  emergencyFundMonths: z.number().int().min(0).max(60),
  aiEnabled: z.boolean(),
});

export type HouseholdSettingsInput = z.infer<typeof householdSettingsSchema>;

/** The settings row as the pages read it: the editable fields plus the budget-related ones. */
export type HouseholdSettings = HouseholdSettingsInput & {
  householdId: string;
  name: string;
  /** The account salary lands in; changed through `setHubAccount`, not `updateHouseholdSettings`. */
  hubAccountId: string | null;
  /** Budget usage percentages that raise an alert, ascending; changed through `setBudgetAlertThresholds`. */
  budgetAlertThresholds: number[];
};

/** `integrations` is injectable for tests; production reads the cached integration config. */
export type HouseholdDeps = SessionDeps & { integrations?: () => Promise<IntegrationConfig> };

/** AI categorisation was switched on although the installation has no `ANTHROPIC_API_KEY`. */
export class AiUnavailableError extends Error {
  constructor() {
    super('AI categorisation is not available on this installation');
    this.name = 'AiUnavailableError';
  }
}

/** What the settings page needs to render the AI switch: availability and both model names. */
export async function aiSettings(cfg?: IntegrationConfig): Promise<{
  aiAvailable: boolean;
  aiModel: string;
  aiReportModel: string;
}> {
  const c = cfg ?? (await getIntegrationConfig());
  return {
    aiAvailable: isAiAvailable(c),
    aiModel: c.models.categorisation.value ?? '',
    aiReportModel: c.models.report.value ?? '',
  };
}

/** The household's settings row (any member may read it). Money formatting follows `locale`. */
export async function getHouseholdSettings(
  headers: Headers,
  deps?: SessionDeps,
): Promise<HouseholdSettings> {
  const ctx = await requireMember(headers, {}, deps);
  const db = deps?.db ?? getDb();
  const [row] = await withHousehold(db, ctx.householdId, (tx) =>
    tx
      .select()
      .from(schema.householdSettings)
      .where(eq(schema.householdSettings.householdId, ctx.householdId)),
  );
  if (!row) throw new Error('Household settings are missing');
  const [org] = await db
    .select({ name: schema.organization.name })
    .from(schema.organization)
    .where(eq(schema.organization.id, ctx.householdId));
  return {
    householdId: row.householdId,
    name: org?.name ?? '',
    currency: row.currency,
    locale: row.locale as HouseholdSettingsInput['locale'],
    timezone: row.timezone,
    fiscalYearStartMonth: row.fiscalYearStartMonth,
    emergencyFundMonths: row.emergencyFundMonths,
    aiEnabled: row.aiEnabled,
    hubAccountId: row.hubAccountId,
    budgetAlertThresholds: row.budgetAlertThresholds,
  };
}

/**
 * Owner-only. Validates the input and updates the household's settings row inside withHousehold.
 * Switching AI on needs the installation's API key (AiUnavailableError otherwise); switching it
 * off is always allowed.
 */
export async function updateHouseholdSettings(
  headers: Headers,
  input: unknown,
  deps?: HouseholdDeps,
): Promise<void> {
  const ctx = await requireMember(headers, { roles: ['owner'], onDenied: 'forbidden' }, deps);
  const values = householdSettingsSchema.parse(input);
  if (values.aiEnabled && !isAiAvailable(await (deps?.integrations ?? getIntegrationConfig)())) {
    throw new AiUnavailableError();
  }
  // The budget year start belongs to Settings > Budget (`updateBudgetSettings`): a form built
  // from a stale read must not overwrite it.
  const { fiscalYearStartMonth, ...editable } = values;
  void fiscalYearStartMonth;
  const db = deps?.db ?? getDb();
  await withHousehold(db, ctx.householdId, (tx) =>
    tx
      .update(schema.householdSettings)
      .set({ ...editable, updatedAt: new Date() })
      .where(eq(schema.householdSettings.householdId, ctx.householdId)),
  );
}

/** Owner-only. Renames the household (a Better Auth organisation) through the server-side API. */
export async function updateHouseholdName(
  headers: Headers,
  name: unknown,
  deps?: SessionDeps,
): Promise<void> {
  const ctx = await requireMember(headers, { roles: ['owner'], onDenied: 'forbidden' }, deps);
  const parsed = nameSchema.parse(name);
  const auth = deps?.auth ?? getAuth();
  await auth.api.updateOrganization({
    headers,
    body: { data: { name: parsed }, organizationId: ctx.householdId },
  });
}
