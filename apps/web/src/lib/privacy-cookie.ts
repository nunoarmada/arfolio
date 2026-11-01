import { cookies } from 'next/headers';
import { PRIVACY_COOKIE, parsePrivacy } from './privacy-setting';

export { PRIVACY_COOKIE, parsePrivacy };

/** Whether this device asked to hide amounts. For server components and layouts. */
export async function readPrivacy(): Promise<boolean> {
  return parsePrivacy((await cookies()).get(PRIVACY_COOKIE)?.value);
}

/** Stores the privacy mode cookie (365 days). Call from server actions only. */
export async function rememberPrivacy(hidden: boolean): Promise<void> {
  (await cookies()).set(PRIVACY_COOKIE, hidden ? 'on' : 'off', {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    // Not a secret, only a display preference: readable so other open tabs can follow a change.
    httpOnly: false,
    secure: (process.env.APP_URL ?? '').startsWith('https://'),
  });
}
