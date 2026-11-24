import { advisorLimits, type AdvisorLimits } from '@arfolio/core';
import {
  hasUnreadNotificationOfKind,
  isAiAvailable,
  listGoals,
  listMessages,
  loadSpendingProfile,
  type AdvisorMessageView,
  type ServiceCtx,
  type SpendingProfile,
} from '@arfolio/services';
import { getEnv } from '../lib/env';
import { loadAiEnabled } from './household-format';
import { getIntegrationConfig } from './integration-config';

/** The notification kind a proactive advisor message raises (added with the notification kinds). */
export const ADVISOR_NOTIFICATION_KIND = 'advisor_message';

/** Messages the advisor page loads at once, and per "older" page. */
export const ADVISOR_PAGE_SIZE = 30;

export type SuggestionKey =
  'howThisMonth' | 'whereSave' | 'emergencyFund' | 'setGoal' | 'whatLearned' | 'reviewGoals';

export type AdvisorState = {
  available: boolean;
  reason?: 'no_key' | 'household_off';
  learning: SpendingProfile['learning'];
  /** The member's own messages, oldest first. */
  messages: AdvisorMessageView[];
  suggestions: SuggestionKey[];
  unreadProactive: boolean;
  canApply: boolean;
};

/** The advisor's numeric limits from the installation's environment. */
export const getAdvisorLimits = (): AdvisorLimits => advisorLimits(getEnv());

/** Exactly three starter questions for the empty chat, picked from what the household has. */
export function pickSuggestions(input: {
  learning: SpendingProfile['learning'];
  hasEmergencyFund: boolean;
  goalsCount: number;
}): SuggestionKey[] {
  if (!input.learning.ready) return ['whatLearned', 'setGoal', 'howThisMonth'];
  if (!input.hasEmergencyFund) return ['howThisMonth', 'emergencyFund', 'whereSave'];
  if (input.goalsCount > 0) return ['howThisMonth', 'reviewGoals', 'whereSave'];
  return ['howThisMonth', 'whereSave', 'setGoal'];
}

/** Everything the advisor page and launcher render, for the signed-in member. */
export async function loadAdvisorState(ctx: ServiceCtx): Promise<AdvisorState> {
  const cfg = await getIntegrationConfig();
  const keyed = isAiAvailable(cfg);
  const enabled = await loadAiEnabled(ctx);
  const [profile, goals, newest, unreadProactive] = await Promise.all([
    loadSpendingProfile(ctx, { learningMonths: getAdvisorLimits().learningMonths }),
    listGoals(ctx),
    listMessages(ctx, { limit: ADVISOR_PAGE_SIZE }),
    hasUnreadNotificationOfKind(ctx, ADVISOR_NOTIFICATION_KIND),
  ]);
  return {
    available: keyed && enabled,
    ...(!keyed
      ? { reason: 'no_key' as const }
      : !enabled
        ? { reason: 'household_off' as const }
        : {}),
    learning: profile.learning,
    messages: newest.reverse(),
    suggestions: pickSuggestions({
      learning: profile.learning,
      hasEmergencyFund: goals.some((g) => g.kind === 'emergency_fund'),
      goalsCount: goals.length,
    }),
    unreadProactive,
    canApply: ctx.role !== 'viewer',
  };
}

/** The page before `before` (the id of the oldest message the caller holds), oldest first. */
export async function loadOlderAdvisorMessages(
  ctx: ServiceCtx,
  before: string,
): Promise<AdvisorMessageView[]> {
  return (await listMessages(ctx, { before, limit: ADVISOR_PAGE_SIZE })).reverse();
}
