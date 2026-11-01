import { ensureHouseholdDefaults, type ServiceCtx } from '@arfolio/services';
import { getDb } from '../lib/db';
import { requireMember, type SessionContext } from './session';

/** The one place a ServiceCtx is built: from the signed-in member's session (never from input). */
export function toServiceCtx(session: SessionContext): ServiceCtx {
  return {
    db: getDb(),
    householdId: session.householdId,
    userId: session.user.id,
    role: session.role,
  };
}

/**
 * Guards the caller like requireMember (sign-in redirect, 2FA, household 404) and returns the
 * ServiceCtx for it. Writes are not narrowed by role here: the services refuse viewers
 * themselves, and the actions report that as a 403. A writer's household without default
 * categories is seeded here (one cheap EXISTS otherwise).
 */
export async function getServiceCtx(
  headers: Headers,
  opts: Parameters<typeof requireMember>[1] = {},
): Promise<ServiceCtx> {
  const ctx = toServiceCtx(await requireMember(headers, opts));
  await ensureHouseholdDefaults(ctx);
  return ctx;
}
