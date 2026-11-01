import { NextResponse, type NextRequest } from 'next/server';
import { getEnv } from '@/lib/env';
import { CALLBACK_PATH, getConnectorDeps } from '@/server/connector-deps';
import { finishConsent, parseCallbackParams } from '@/server/consent-callback';
import { toServiceCtx } from '@/server/service-ctx';
import { getSessionContext } from '@/server/session';

/**
 * Where the bank sends the person back after the consent (`?state&code`, or `?error` when they
 * cancel). It only ever redirects, and only to fixed in-app paths: provider text is never echoed.
 * A signed-out visitor goes to sign-in and returns here afterwards.
 */
export async function GET(request: NextRequest) {
  // The public URL comes from configuration: behind a proxy request.url is the internal address.
  const origin = getEnv().APP_URL;
  const go = (path: string) => NextResponse.redirect(new URL(path, origin), 303);

  const session = await getSessionContext(request.headers);
  if (!session) {
    const next = `${CALLBACK_PATH}${request.nextUrl.search}`;
    return go(`/sign-in?next=${encodeURIComponent(next)}`);
  }
  if (session.role === 'owner' && !session.user.twoFactorEnabled) return go('/two-factor/setup');

  const path = await finishConsent(
    toServiceCtx(session),
    await getConnectorDeps(),
    parseCallbackParams(request.nextUrl.searchParams),
  );
  return go(path);
}
