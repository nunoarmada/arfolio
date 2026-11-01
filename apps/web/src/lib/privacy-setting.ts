/** Privacy mode setting, shared by server and client (no server-only imports here). */
export const PRIVACY_COOKIE = 'privacy';

/** Only an explicit "on" hides amounts; a missing or unexpected value means visible. */
export function parsePrivacy(raw: string | undefined): boolean {
  return raw === 'on';
}

/** The setting from a `document.cookie` string, to pick up a change made in another tab. */
export function privacyFromCookies(cookies: string): boolean {
  const pair = cookies
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${PRIVACY_COOKIE}=`));
  return parsePrivacy(pair?.slice(PRIVACY_COOKIE.length + 1));
}

/**
 * Saves a toggle that is already shown. If saving fails (offline, server error) the switch goes
 * back, so the screen matches what this device will render next, and the failure is reported.
 */
export async function persistPrivacy(
  next: boolean,
  deps: {
    save: (hidden: boolean) => Promise<void>;
    revert: (hidden: boolean) => void;
    report: (error: unknown) => void;
  },
): Promise<void> {
  try {
    await deps.save(next);
  } catch (error) {
    deps.revert(!next);
    deps.report(error);
  }
}
