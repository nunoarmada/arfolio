'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  applyProposal,
  clearHistory,
  deleteNote,
  dismissProposal,
  loadSpendingProfile,
  markNotificationsReadByKind,
  saveMemberSettings,
  type AdvisorMemberSettings,
  type AdvisorMessageView,
} from '@arfolio/services';
import {
  ADVISOR_NOTIFICATION_KIND,
  getAdvisorLimits,
  loadAdvisorPanel,
  loadAdvisorState,
  loadOlderAdvisorMessages,
  type AdvisorPanel,
  type AdvisorState,
} from '../advisor-data';
import { getServiceCtx } from '../service-ctx';
import { run, type ActionResult } from './result';

const refresh = () => revalidatePath('/', 'layout');

async function ctx() {
  return getServiceCtx(await headers());
}

/** Applies a pending proposal (owner or member). The status flip makes a second click a conflict. */
export async function applyAdvisorProposalAction(id: string): Promise<ActionResult> {
  return run(async () => {
    const c = await ctx();
    const profile = await loadSpendingProfile(c, {
      learningMonths: getAdvisorLimits().learningMonths,
    });
    await applyProposal(c, id, { profile });
    refresh();
    return null;
  });
}

export async function dismissAdvisorProposalAction(id: string): Promise<ActionResult> {
  return run(async () => {
    await dismissProposal(await ctx(), id);
    refresh();
    return null;
  });
}

export async function deleteAdvisorNoteAction(id: string): Promise<ActionResult> {
  return run(async () => {
    await deleteNote(await ctx(), id);
    refresh();
    return null;
  });
}

export async function clearAdvisorHistoryAction(): Promise<ActionResult> {
  return run(async () => {
    await clearHistory(await ctx());
    refresh();
    return null;
  });
}

export async function saveAdvisorSettingsAction(
  settings: AdvisorMemberSettings,
): Promise<ActionResult> {
  return run(async () => {
    await saveMemberSettings(await ctx(), settings);
    refresh();
    return null;
  });
}

/** The member opened the advisor: their proactive-message notifications count as read. */
export async function markAdvisorSeenAction(): Promise<ActionResult> {
  return run(async () => {
    await markNotificationsReadByKind(await ctx(), ADVISOR_NOTIFICATION_KIND);
    refresh();
    return null;
  });
}

/** The page of messages before `before` (the oldest one the caller holds), oldest first. */
export async function loadOlderAdvisorMessagesAction(
  before: string,
): Promise<ActionResult<AdvisorMessageView[]>> {
  return run(async () => loadOlderAdvisorMessages(await ctx(), before));
}

/** The whole advisor state for the chat window, which loads it when first opened. */
export async function loadAdvisorStateAction(): Promise<ActionResult<AdvisorState>> {
  return run(async () => loadAdvisorState(await ctx()));
}

/** The member's notes and settings for the header-menu panels. */
export async function loadAdvisorPanelAction(): Promise<ActionResult<AdvisorPanel>> {
  return run(async () => loadAdvisorPanel(await ctx()));
}
