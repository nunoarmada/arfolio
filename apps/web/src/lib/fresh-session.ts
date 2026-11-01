/**
 * Actions that hand out long-lived access (personal access tokens, OAuth consent) need a recent
 * sign-in, so a stolen or forgotten session cannot mint credentials that outlive it.
 */
export const FRESH_SESSION_MAX_AGE_MS = 10 * 60_000;

/** True when the session was created (the user signed in) within the last 10 minutes. */
export function isFreshSession(createdAt: Date | string | number, now = Date.now()): boolean {
  const created = new Date(createdAt).getTime();
  return Number.isFinite(created) && now - created < FRESH_SESSION_MAX_AGE_MS;
}
