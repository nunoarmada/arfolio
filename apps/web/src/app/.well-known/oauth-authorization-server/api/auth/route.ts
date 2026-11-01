import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';
import { getAuth } from '@/lib/auth';
import { withDiscoveryCache } from '@/lib/discovery';

// RFC 8414 puts the authorization server metadata of the issuer `${APP_URL}/api/auth` at this
// root path; Better Auth only serves it under its base path, so it is re-exported here.
export const dynamic = 'force-dynamic';

export const GET = async (req: Request) =>
  withDiscoveryCache(await oauthProviderAuthServerMetadata(getAuth())(req));
