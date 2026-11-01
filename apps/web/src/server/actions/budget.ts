'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  addCategoryToLine,
  archiveBudget,
  createBudget,
  deleteBudgetLine,
  renameBudget,
  saveBudgetLine,
  unarchiveBudget,
  type SaveBudgetLineInput,
} from '@arfolio/services';
import { getServiceCtx } from '../service-ctx';
import { toBudgetDto, type BudgetDto } from '../budget-data';
import { run, type ActionResult } from './result';

const refresh = () => revalidatePath('/', 'layout');

/** An empty budget, or a copy of another (lines, categories and amounts). */
export async function createBudgetAction(input: {
  startMonth: string;
  copyFromBudgetId?: string;
}): Promise<ActionResult<BudgetDto>> {
  return run(async () => {
    const created = await createBudget(await getServiceCtx(await headers()), {
      startMonth: input.startMonth,
      ...(input.copyFromBudgetId ? { copyFromBudgetId: input.copyFromBudgetId } : {}),
    });
    refresh();
    return toBudgetDto(created);
  });
}

export async function renameBudgetAction(
  id: string,
  name: string,
): Promise<ActionResult<BudgetDto>> {
  return run(async () => {
    const row = await renameBudget(await getServiceCtx(await headers()), id, name);
    refresh();
    return toBudgetDto(row);
  });
}

export async function setBudgetArchivedAction(
  id: string,
  archived: boolean,
): Promise<ActionResult<BudgetDto>> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    const row = archived ? await archiveBudget(ctx, id) : await unarchiveBudget(ctx, id);
    refresh();
    return toBudgetDto(row);
  });
}

/** The line editor's save: the line, its twelve amounts and its categories in one transaction. */
export async function saveBudgetLineAction(
  budgetId: string,
  input: SaveBudgetLineInput,
): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const saved = await saveBudgetLine(await getServiceCtx(await headers()), budgetId, input);
    refresh();
    return { id: saved.id };
  });
}

export async function deleteBudgetLineAction(lineId: string): Promise<ActionResult> {
  return run(async () => {
    await deleteBudgetLine(await getServiceCtx(await headers()), lineId);
    refresh();
    return null;
  });
}

/** Adds one category to a line's set (the month view's "Associar a uma rubrica"). */
export async function linkCategoryToLineAction(
  lineId: string,
  categoryId: string,
): Promise<ActionResult> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    await addCategoryToLine(ctx, lineId, categoryId);
    refresh();
    return null;
  });
}
