import { sql } from 'drizzle-orm';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Db } from './client.js';

const APP_ROLE = 'pfm_app';

const ROLE_ATTRIBUTES = 'login nosuperuser nobypassrls nocreatedb nocreaterole noinherit';

/** SCRAM-SHA-256 verifier (RFC 5802 / Postgres format), so the plaintext never reaches the server. */
export function scramVerifier(password: string, iterations = 4096): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const hmac = (key: Buffer, msg: string) => createHmac('sha256', key).update(msg).digest();
  const storedKey = createHash('sha256').update(hmac(salted, 'Client Key')).digest();
  const serverKey = hmac(salted, 'Server Key');
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/**
 * CREATE/ALTER ROLE accept no bind parameters, so the verifier (base64 only, no quotes) is
 * inlined as a literal. Runs through the raw pool, not drizzle, and rethrows a sanitized error
 * (no query text, params or cause) so nothing sensitive reaches logs.
 */
async function upsertRole(pool: pg.Pool, password: string): Promise<void> {
  const verifier = scramVerifier(password);
  if (!/^[A-Za-z0-9+/=$:-]+$/.test(verifier)) throw new Error('unexpected SCRAM verifier format');
  let verb = 'create';
  try {
    const existing = await pool.query('select 1 from pg_roles where rolname = $1', [APP_ROLE]);
    if (existing.rowCount) verb = 'alter';
    await pool.query(`${verb} role ${APP_ROLE} ${ROLE_ATTRIBUTES} password '${verifier}'`);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    // eslint-disable-next-line preserve-caught-error -- the cause could embed the statement
    throw new Error(
      `failed to ${verb} role ${APP_ROLE}: ${e.code ?? 'unknown'} ${e.message ?? ''}`,
    );
  }
}

/**
 * Creates (or updates the password of) the login role the app and worker connect as, and grants
 * it DML only: it owns nothing, so it cannot alter schema and RLS applies to it.
 * Run as the table owner; idempotent.
 */
export async function ensureAppRole(ownerDb: Db, password: string): Promise<void> {
  if (!password) throw new Error('ensureAppRole: password must be a non-empty string');
  await upsertRole(ownerDb.$client, password);
  // Postgres < 15 lets PUBLIC create tables in public; make sure pfm_app never can.
  await ownerDb.execute(sql.raw('revoke create on schema public from public'));
  await ownerDb.execute(sql.raw(`grant usage on schema public to ${APP_ROLE}`));
  await ownerDb.execute(
    sql.raw(`grant select, insert, update, delete on all tables in schema public to ${APP_ROLE}`),
  );
  await ownerDb.execute(sql.raw(`grant usage on all sequences in schema public to ${APP_ROLE}`));
  // audit_log is append-only: the blanket grant above (and the default privileges below, for
  // tables created later) must not let the app role edit or remove audit rows.
  await ownerDb.execute(sql.raw(`revoke update, delete, truncate on audit_log from ${APP_ROLE}`));
  // Security-definer functions the app role calls directly: claim_push_endpoint (0026) lets a
  // household release a push endpoint that a device previously registered under another household;
  // pat_lookup (0030) finds a personal access token by hash before any household is known.
  // Revoked from PUBLIC in the migrations. (The member-delete trigger functions of 0028 and 0030
  // are also security definer, but they are only ever run by their triggers and are not granted
  // to the app role.)
  await ownerDb.execute(
    sql.raw(`grant execute on function claim_push_endpoint(text) to ${APP_ROLE}`),
  );
  await ownerDb.execute(sql.raw(`grant execute on function pat_lookup(bytea) to ${APP_ROLE}`));
  // Default privileges apply to objects created by the role running this (the migrating owner).
  await ownerDb.execute(
    sql.raw(
      `alter default privileges in schema public grant select, insert, update, delete on tables to ${APP_ROLE}`,
    ),
  );
  await ownerDb.execute(
    sql.raw(`alter default privileges in schema public grant usage on sequences to ${APP_ROLE}`),
  );

  // The pg-boss schema is installed by runMigrations just before this; grant on it when present.
  const { rows: boss } = await ownerDb.execute(
    sql`select 1 from pg_namespace where nspname = 'pgboss'`,
  );
  if (boss.length > 0) {
    await ownerDb.execute(sql.raw(`grant usage on schema pgboss to ${APP_ROLE}`));
    await ownerDb.execute(
      sql.raw(`grant select, insert, update, delete on all tables in schema pgboss to ${APP_ROLE}`),
    );
    await ownerDb.execute(sql.raw(`grant usage on all sequences in schema pgboss to ${APP_ROLE}`));
    await ownerDb.execute(
      sql.raw(`grant execute on all functions in schema pgboss to ${APP_ROLE}`),
    );
    await ownerDb.execute(
      sql.raw(
        `alter default privileges in schema pgboss grant select, insert, update, delete on tables to ${APP_ROLE}`,
      ),
    );
    await ownerDb.execute(
      sql.raw(`alter default privileges in schema pgboss grant usage on sequences to ${APP_ROLE}`),
    );
    await ownerDb.execute(
      sql.raw(
        `alter default privileges in schema pgboss grant execute on functions to ${APP_ROLE}`,
      ),
    );
  }
}
