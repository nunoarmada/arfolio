import { createRateLimiter } from '@/lib/rate-limit';
import { getAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { createMcpRequestHandler } from '@/server/mcp-auth';

// The MCP endpoint (streamable HTTP, stateless): a fresh server per request, authenticated by a
// Bearer personal access token or OAuth access token. It never reads cookies.
export const dynamic = 'force-dynamic';

// 120 requests a minute per credential, in memory (single instance).
const limiter = createRateLimiter({ max: 120, windowMs: 60_000 });

const handle = (req: Request) =>
  createMcpRequestHandler({ db: getDb(), auth: getAuth(), env: getEnv(), limiter })(req);

// Stateless mode answers GET (SSE stream) and DELETE (session end) with 405.
export const POST = handle;
export const GET = handle;
export const DELETE = handle;
