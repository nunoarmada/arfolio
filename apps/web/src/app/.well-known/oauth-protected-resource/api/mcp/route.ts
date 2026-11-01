import { getAuth } from '@/lib/auth';
import { withDiscoveryCache } from '@/lib/discovery';

// RFC 9728 protected resource metadata of `${APP_URL}/api/mcp`. The mcp() plugin answers this
// exact path when the request reaches auth.handler, so the request is passed through unchanged.
export const dynamic = 'force-dynamic';

export const GET = async (req: Request) => withDiscoveryCache(await getAuth().handler(req));
