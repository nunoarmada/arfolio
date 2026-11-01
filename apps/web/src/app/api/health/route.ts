import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

const DB_TIMEOUT_MS = 3000;

/** Liveness plus a database round trip: 200 {status:'ok', db:true}, or 503 when the DB is down. */
export async function GET(): Promise<Response> {
  let db = false;
  try {
    await Promise.race([
      getDb().execute(sql`select 1`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('database check timed out')), DB_TIMEOUT_MS).unref(),
      ),
    ]);
    db = true;
  } catch {
    // Never echo the error: it can carry connection details.
  }
  return Response.json(
    { status: db ? 'ok' : 'degraded', db },
    { status: db ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
