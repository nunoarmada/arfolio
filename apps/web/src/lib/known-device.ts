import { createHash } from 'node:crypto';

/** How long a browser stays "known" after its last successful sign-in. */
export const KNOWN_DEVICE_MAX_AGE_S = 180 * 24 * 60 * 60;

const COOKIE_PREFIX = 'pfm_kd_';

/** SHA-256 of the user id: what the cookie is bound to (the id itself never leaves the server). */
export function userHash(userId: string): string {
  return createHash('sha256').update(userId).digest('hex');
}

/** One cookie per account, so several accounts can share a browser. */
export function knownDeviceCookieName(userId: string): string {
  return `${COOKIE_PREFIX}${userHash(userId).slice(0, 16)}`;
}

/**
 * Fingerprint of the credentials the cookie was issued under: it changes with the password hash
 * (change or reset) and with the 2FA flag, which invalidates every known-device cookie.
 */
export function credentialFingerprint(
  userId: string,
  passwordHash: string | null | undefined,
  twoFactorEnabled: boolean | null | undefined,
): string {
  return createHash('sha256')
    .update(`${userId}\0${passwordHash ?? ''}\0${twoFactorEnabled ? '2fa' : ''}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Cookie value (signed by Better Auth with the auth secret): the user hash, the issue time and
 * the credential fingerprint.
 */
export function knownDeviceValue(userId: string, fingerprint: string, now = Date.now()): string {
  return `${userHash(userId)}:${now}:${fingerprint}`;
}

/**
 * True when the (already signature-checked) value was issued to this user under the same
 * credentials and has not expired.
 */
export function isValidKnownDeviceValue(
  value: string | null | undefined,
  userId: string,
  fingerprint: string,
  now = Date.now(),
): boolean {
  if (!value) return false;
  const [hash, issuedAt, fp, ...rest] = value.split(':');
  if (rest.length > 0 || hash !== userHash(userId) || fp !== fingerprint) return false;
  const issued = Number(issuedAt);
  return Number.isFinite(issued) && issued <= now && now - issued < KNOWN_DEVICE_MAX_AGE_S * 1000;
}

export function hasKnownDeviceCookie(cookieHeader: unknown): boolean {
  return typeof cookieHeader === 'string' && cookieHeader.includes(COOKIE_PREFIX);
}
