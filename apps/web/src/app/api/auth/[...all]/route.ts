import { toNextJsHandler } from 'better-auth/next-js';
import { getAuth } from '@/lib/auth';

// Build the handlers on first request so importing this module (during `next build`) does not
// require runtime configuration.
const handlers = () => toNextJsHandler(getAuth());

export const GET = (req: Request) => handlers().GET(req);
export const POST = (req: Request) => handlers().POST(req);
