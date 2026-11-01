'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  applyRule,
  createRule,
  deleteRule,
  NotFoundError,
  previewRuleApplication,
  reorderRules,
  revertRuleApplication,
  updateRule,
  type CreateRuleInput,
  type UpdateRulePatch,
} from '@arfolio/services';
import { getServiceCtx } from '../service-ctx';
import { toRuleDto, type RuleDto } from '../serialize';
import { run, type ActionResult } from './result';

const refresh = () => revalidatePath('/', 'layout');

async function ctx() {
  return getServiceCtx(await headers());
}

export async function createRuleAction(input: CreateRuleInput): Promise<ActionResult<RuleDto>> {
  return run(async () => {
    const rule = await createRule(await ctx(), input);
    refresh();
    return toRuleDto(rule);
  });
}

export async function updateRuleAction(
  id: string,
  patch: UpdateRulePatch,
): Promise<ActionResult<RuleDto>> {
  return run(async () => {
    const rule = await updateRule(await ctx(), id, patch);
    refresh();
    return toRuleDto(rule);
  });
}

export async function deleteRuleAction(id: string): Promise<ActionResult> {
  return run(async () => {
    await deleteRule(await ctx(), id);
    refresh();
    return null;
  });
}

/** Rules apply in ascending priority: `ids` are the rules in the order they should apply. */
export async function reorderRulesAction(ids: string[]): Promise<ActionResult> {
  return run(async () => {
    await reorderRules(await ctx(), ids);
    refresh();
    return null;
  });
}

/**
 * A rule that was deleted in the meantime reads as a plain failure the dialog explains in place,
 * not as the 404 page `run` would render for a NotFoundError.
 */
async function inPlace<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof NotFoundError) throw new Error('rule not found', { cause: error });
    throw error;
  }
}

/** What `applyRuleAction` would change right now (viewers may look). */
export async function previewRuleApplicationAction(
  ruleId: string,
): Promise<ActionResult<{ matches: number; changes: number }>> {
  return run(() => inPlace(async () => previewRuleApplication(await ctx(), ruleId)));
}

/** Categorises the rule's existing transactions. The service refuses viewers (reported as 403). */
export async function applyRuleAction(
  ruleId: string,
): Promise<ActionResult<{ changed: number; undoToken: string | null }>> {
  return run(async () => {
    const result = await inPlace(async () => applyRule(await ctx(), ruleId));
    if (result.changed > 0) refresh();
    return result;
  });
}

export type RevertRuleResult =
  { expired: false; restored: number; kept: number } | { expired: true };

/** Undoes an application. An unknown, expired or foreign token is `expired`, not a 404. */
export async function revertRuleApplicationAction(
  undoToken: string,
): Promise<ActionResult<RevertRuleResult>> {
  return run(async () => {
    const context = await ctx();
    try {
      const result = await revertRuleApplication(context, undoToken);
      refresh();
      return { expired: false as const, ...result };
    } catch (error) {
      if (error instanceof NotFoundError) return { expired: true as const };
      throw error;
    }
  });
}
