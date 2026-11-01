'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  archiveCategory,
  archiveCategoryGroup,
  createCategory,
  createCategoryGroup,
  deleteCategory,
  deleteCategoryGroup,
  reorderCategories,
  reorderCategoryGroups,
  updateCategory,
  updateCategoryGroup,
  type CreateCategoryGroupInput,
  type CreateCategoryInput,
  type UpdateCategoryGroupPatch,
  type UpdateCategoryPatch,
} from '@arfolio/services';
import { getServiceCtx } from '../service-ctx';
import { run, type ActionResult } from './result';

const refresh = () => revalidatePath('/', 'layout');

async function ctx() {
  return getServiceCtx(await headers());
}

export async function createGroupAction(input: CreateCategoryGroupInput): Promise<ActionResult> {
  return run(async () => {
    await createCategoryGroup(await ctx(), input);
    refresh();
    return null;
  });
}

export async function updateGroupAction(
  id: string,
  patch: UpdateCategoryGroupPatch,
): Promise<ActionResult> {
  return run(async () => {
    await updateCategoryGroup(await ctx(), id, patch);
    refresh();
    return null;
  });
}

export async function archiveGroupAction(id: string): Promise<ActionResult> {
  return run(async () => {
    await archiveCategoryGroup(await ctx(), id);
    refresh();
    return null;
  });
}

export async function deleteGroupAction(id: string): Promise<ActionResult> {
  return run(async () => {
    await deleteCategoryGroup(await ctx(), id);
    refresh();
    return null;
  });
}

export async function createCategoryAction(input: CreateCategoryInput): Promise<ActionResult> {
  return run(async () => {
    await createCategory(await ctx(), input);
    refresh();
    return null;
  });
}

export async function updateCategoryAction(
  id: string,
  patch: UpdateCategoryPatch,
): Promise<ActionResult> {
  return run(async () => {
    await updateCategory(await ctx(), id, patch);
    refresh();
    return null;
  });
}

export async function archiveCategoryAction(id: string): Promise<ActionResult> {
  return run(async () => {
    await archiveCategory(await ctx(), id);
    refresh();
    return null;
  });
}

export async function deleteCategoryAction(id: string, reassignTo?: string): Promise<ActionResult> {
  return run(async () => {
    await deleteCategory(await ctx(), id, reassignTo ? { reassignTo } : {});
    refresh();
    return null;
  });
}

/** Saves a new order: `ids` are the siblings in the order they should appear. */
export async function reorderGroupsAction(ids: string[]): Promise<ActionResult> {
  return run(async () => {
    await reorderCategoryGroups(await ctx(), ids);
    refresh();
    return null;
  });
}

export async function reorderCategoriesAction(ids: string[]): Promise<ActionResult> {
  return run(async () => {
    await reorderCategories(await ctx(), ids);
    refresh();
    return null;
  });
}
