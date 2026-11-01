import { NextResponse, type NextRequest } from 'next/server';

/**
 * Per-request Content-Security-Policy with a nonce (Next 16 `proxy`, the successor of middleware).
 * Next reads the nonce from the request's CSP header and stamps it on its own scripts, which is
 * why every page here renders dynamically. `strict-dynamic` lets those scripts load their chunks.
 *
 * Styles: `style-src` is nonce-only for <style>/<link> elements; `style-src-attr 'unsafe-inline'`
 * is the one concession, because component libraries emit style="" attributes (positioning,
 * CSS variables) and attribute styles cannot execute script.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';
  const secure = (process.env.APP_URL ?? '').startsWith('https://');

  let logoOrigin = '';
  try {
    if (process.env.BRAND_LOGO_URL) logoOrigin = new URL(process.env.BRAND_LOGO_URL).origin;
  } catch {
    // An invalid BRAND_LOGO_URL fails env validation at boot; nothing to allow here.
  }

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' data: blob:${logoOrigin ? ` ${logoOrigin}` : ''}`,
    "font-src 'self'",
    `connect-src 'self'${isDev ? ' ws:' : ''}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(secure ? ['upgrade-insecure-requests'] : []),
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  // Invite and setup links may carry a secret in the query string: never leak them via Referer.
  const { pathname } = request.nextUrl;
  if (pathname.startsWith('/invite/') || pathname === '/setup') {
    response.headers.set('Referrer-Policy', 'no-referrer');
  }
  return response;
}

export const config = {
  matcher: [
    {
      source:
        '/((?!api|\\.well-known|_next/static|_next/image|favicon.ico|icon.svg|icons|og|manifest.webmanifest|sw.js|swe-worker).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
