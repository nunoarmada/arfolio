'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { updateBudgetSettings } from '@arfolio/services';
import { getServiceCtx } from '../service-ctx';
import { run, type ActionResult } from './result';

export interface BudgetSettingsInput {
  fiscalYearStartMonth: number;
  hubAccountId: string | null;
  thresholds: number[];
}

/** The three budget settings, saved in one transaction (owners only: the service refuses the rest). */
export async function saveBudgetSettingsAction(input: BudgetSettingsInput): Promise<ActionResult> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    await updateBudgetSettings(ctx, {
      fiscalYearStartMonth: input.fiscalYearStartMonth,
      hubAccountId: input.hubAccountId,
      budgetAlertThresholds: input.thresholds,
    });
    revalidatePath('/', 'layout');
    return null;
  });
}
