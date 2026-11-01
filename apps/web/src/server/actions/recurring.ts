'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  confirmRecurring,
  declareRecurring,
  dismissRecurring,
  reopenRecurring,
  updateRecurring,
  type DeclareRecurringInput,
  type UpdateRecurringPatch,
} from '@arfolio/services';
import type { RecurringDto } from '../../lib/recurring-display';
import { getServiceCtx } from '../service-ctx';
import { toRecurringDto } from '../budget-data';
import { run, type ActionResult } from './result';

const refresh = () => revalidatePath('/', 'layout');

async function ctx() {
  return getServiceCtx(await headers());
}

export async function confirmRecurringAction(id: string): Promise<ActionResult<RecurringDto>> {
  return run(async () => {
    const row = await confirmRecurring(await ctx(), id);
    refresh();
    return toRecurringDto(row);
  });
}

export async function dismissRecurringAction(id: string): Promise<ActionResult<RecurringDto>> {
  return run(async () => {
    const row = await dismissRecurring(await ctx(), id);
    refresh();
    return toRecurringDto(row);
  });
}

/** "Anular" after a confirm or a dismiss of a detected item. */
export async function reopenRecurringAction(id: string): Promise<ActionResult<RecurringDto>> {
  return run(async () => {
    const row = await reopenRecurring(await ctx(), id);
    refresh();
    return toRecurringDto(row);
  });
}

export async function declareRecurringAction(
  input: DeclareRecurringInput,
): Promise<ActionResult<RecurringDto>> {
  return run(async () => {
    const row = await declareRecurring(await ctx(), input);
    refresh();
    return toRecurringDto(row);
  });
}

export async function updateRecurringAction(
  id: string,
  patch: UpdateRecurringPatch,
): Promise<ActionResult<RecurringDto>> {
  return run(async () => {
    const row = await updateRecurring(await ctx(), id, patch);
    refresh();
    return toRecurringDto(row);
  });
}
