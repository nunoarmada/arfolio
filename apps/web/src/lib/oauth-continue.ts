/**
 * The OAuth provider answers a sign-in (or 2FA) request that carried a signed `oauth_query` with
 * `{ redirect: true, url }`, where `url` continues the authorization (consent page or the
 * client's callback). Ordinary sign-ins answer `redirect: false`.
 */
export function oauthRedirectUrl(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const { redirect, url } = data as { redirect?: unknown; url?: unknown };
  return redirect === true && typeof url === 'string' && url !== '' ? url : null;
}

/**
 * The page's query string when it is a signed OAuth request (the provider adds `sig`), so it can
 * be carried from /sign-in to /two-factor; empty for every other visit.
 */
export function oauthSearch(search: string): string {
  return new URLSearchParams(search).has('sig') ? search : '';
}
