import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface CreateDbOptions {
  max?: number;
  /** Server-side `statement_timeout` for every query on this pool; unset means no limit. */
  statementTimeoutMs?: number;
  /** Receives the message (never the error object) of errors on idle clients. */
  onError?: (message: string) => void;
}

const CONNECTION_TIMEOUT_MS = 5_000;

export function createDb(url: string, opts: CreateDbOptions = {}): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: opts.statementTimeoutMs,
    query_timeout: opts.statementTimeoutMs ? opts.statementTimeoutMs + 500 : undefined,
  });
  // Without a listener an idle-client error (e.g. Postgres restarting) is an uncaught exception.
  // The pool discards the broken client and opens a fresh one on the next query.
  const onError = opts.onError ?? ((message) => console.error(`pg pool error: ${message}`));
  pool.on('error', (err) => onError(err.message));
  const db = drizzle(pool, { schema });
  return { db, pool };
}
