import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.js';
import { ensureAppRole } from './roles.js';

// src/ and dist/ both sit one level below the package root that holds migrations/. Built with
// path.join rather than `new URL('../migrations', import.meta.url)` so bundlers (Next/Turbopack,
// which pulls this package in through the barrel) do not try to resolve the folder as an asset.
const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Installs or upgrades the pg-boss schema as the owner, so the worker (pfm_app) never needs DDL.
 * No timers or workers are armed: the instance starts, migrates and stops.
 * pg-boss is imported lazily: it is ESM-only and this module is re-exported by the barrel that
 * apps/web bundles, so a static import would pull pg-boss into the web server bundle.
 */
async function installPgBoss(ownerUrl: string): Promise<void> {
  const { PgBoss } = await import('pg-boss');
  const boss = new PgBoss({
    connectionString: ownerUrl,
    max: 1,
    migrate: true,
    createSchema: true,
    supervise: false,
    schedule: false,
  });
  // An unhandled 'error' event would crash the process; start() still rejects on real failures,
  // so the event carries nothing the caller needs.
  boss.on('error', () => {});
  await boss.start();
  await boss.stop({ graceful: false });
}

/**
 * Applies pending migrations, installs the pg-boss schema, then (re)applies the pfm_app role and
 * grants. Run as the owner.
 */
export async function runMigrations(ownerUrl: string, appPassword: string): Promise<void> {
  const { db, pool } = createDb(ownerUrl, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    await installPgBoss(ownerUrl);
    await ensureAppRole(db, appPassword);
  } finally {
    await pool.end();
  }
}

/**
 * True when `moduleUrl` is the script node was started with. import.meta.url is always a real
 * path while argv[1] is not (pnpm links, symlinked mounts), so argv[1] is resolved first;
 * otherwise a symlinked invocation would silently skip the CLI and exit 0 without migrating.
 */
export function isCliEntry(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return fileURLToPath(moduleUrl) === realpathSync(argv1);
  } catch {
    return false;
  }
}

// CLI entry: `node dist/migrate.js` (the Docker `migrate` command).
if (isCliEntry(import.meta.url, process.argv[1])) {
  const ownerUrl = process.env.DATABASE_OWNER_URL;
  const appPassword = process.env.APP_DB_PASSWORD;
  if (!ownerUrl || !appPassword) {
    console.error('DATABASE_OWNER_URL and APP_DB_PASSWORD are required');
    process.exit(1);
  }
  runMigrations(ownerUrl, appPassword).then(
    () => console.log('migrations applied'),
    (err: unknown) => {
      // Log only the message: raw error objects may carry query text or params.
      console.error(`migration failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      process.exit(1);
    },
  );
}
