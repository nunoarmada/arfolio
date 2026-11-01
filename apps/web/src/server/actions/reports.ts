'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  AiUnavailableError,
  isAiAvailable,
  requestReport,
  ValidationError,
} from '@arfolio/services';
import { getIntegrationConfig } from '../integration-config';
import { toServiceCtx } from '../service-ctx';
import { requireMember } from '../session';
import { run, type ActionResult } from './result';

/**
 * `requested`: the report is pending now. `unavailable`: AI is off or the installation has no key.
 * `not_latest`: only the last closed month can be asked for from the interface.
 */
export type RequestReportOutcome = 'requested' | 'unavailable' | 'not_latest';

/**
 * Asks for the report of `month`. Owners and members only (a viewer gets a 403 result). The
 * service creates or resets the row to pending; the worker writes the report, so nothing here
 * calls a model.
 */
export async function requestReportAction(
  month: string,
): Promise<ActionResult<RequestReportOutcome>> {
  return run(async () => {
    const session = await requireMember(await headers(), {
      roles: ['owner', 'member'],
      onDenied: 'forbidden',
    });
    const ctx = toServiceCtx(session);
    try {
      await requestReport(
        ctx,
        { month },
        { aiAvailable: isAiAvailable(await getIntegrationConfig()) },
      );
    } catch (error) {
      if (error instanceof AiUnavailableError) return 'unavailable';
      if (
        error instanceof ValidationError &&
        (error.code === 'month_not_closed' || error.code === 'month_not_allowed')
      ) {
        return 'not_latest';
      }
      throw error;
    }
    revalidatePath('/insights/reports', 'layout');
    return 'requested';
  });
}
