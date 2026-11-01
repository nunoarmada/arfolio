/**
 * OAuth discovery documents (RFC 8414 / RFC 9728) change only on deploy: cache them for five
 * minutes. Anything that is not a success (the plugin answers 404/405 for other paths) is never
 * cached.
 */
export function withDiscoveryCache(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', res.ok ? 'max-age=300' : 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
