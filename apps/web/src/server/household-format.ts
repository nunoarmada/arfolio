import { eq } from 'drizzle-orm';
import { cache } from 'react';
import { schema, withHousehold } from '@arfolio/db';
import type { ServiceCtx } from '@arfolio/services';
import { getDb } from '../lib/db';

/** How this household reads money and dates. Never hard-coded: it comes from its settings row. */
export interface HouseholdFormat {
  locale: string;
  timeZone: string;
  currency: string;
}

const load = cache(async (householdId: string): Promise<HouseholdFormat> => {
  const [row] = await withHousehold(getDb(), householdId, (tx) =>
    tx
      .select({
        locale: schema.householdSettings.locale,
        timeZone: schema.householdSettings.timezone,
        currency: schema.householdSettings.currency,
      })
      .from(schema.householdSettings)
      .where(eq(schema.householdSettings.householdId, householdId)),
  );
  if (!row) throw new Error('Household settings are missing');
  return row;
});

export function loadHouseholdFormat(ctx: ServiceCtx): Promise<HouseholdFormat> {
  return load(ctx.householdId);
}

const loadAi = cache(async (householdId: string): Promise<boolean> => {
  const [row] = await withHousehold(getDb(), householdId, (tx) =>
    tx
      .select({ aiEnabled: schema.householdSettings.aiEnabled })
      .from(schema.householdSettings)
      .where(eq(schema.householdSettings.householdId, householdId)),
  );
  return row?.aiEnabled ?? false;
});

/** Whether this household switched AI categorisation on (drives which AI controls are offered). */
export function loadAiEnabled(ctx: ServiceCtx): Promise<boolean> {
  return loadAi(ctx.householdId);
}
