'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { archiveGoal, createGoal, updateGoal } from '@arfolio/services';
import type { GoalInput } from '../../lib/goals';
import { getServiceCtx } from '../service-ctx';
import { run, type ActionResult } from './result';

const refresh = () => revalidatePath('/', 'layout');

export async function createGoalAction(input: GoalInput): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const row = await createGoal(await getServiceCtx(await headers()), input);
    refresh();
    return { id: row.id };
  });
}

export async function updateGoalAction(
  id: string,
  input: GoalInput,
): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const row = await updateGoal(await getServiceCtx(await headers()), id, input);
    refresh();
    return { id: row.id };
  });
}

export async function archiveGoalAction(id: string): Promise<ActionResult> {
  return run(async () => {
    await archiveGoal(await getServiceCtx(await headers()), id);
    refresh();
    return null;
  });
}
