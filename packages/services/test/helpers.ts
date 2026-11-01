import { randomUUID } from 'node:crypto';
import { createDb, schema, withHousehold, type Db } from '@arfolio/db';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../db/test/pg.js';
import type { ServiceCtx } from '../src/index.js';

export interface ServicesTestDb {
  db: Db;
  /** Connection as the table owner (bypasses RLS) for arranging or inspecting data. */
  owner: Db;
  /** Creates a household (organisation + settings) and returns a ctx for it. */
  household(opts?: {
    locale?: string;
    currency?: string;
    role?: ServiceCtx['role'];
  }): Promise<ServiceCtx>;
  close(): Promise<void>;
}

/**
 * One migrated throwaway database per test file, reusing the db package's cluster setup
 * (`startTestDb`), with the app connection running as `pfm_app` so RLS applies.
 */
export async function startServicesDb(): Promise<ServicesTestDb> {
  const testDb: TestDb = await startTestDb();
  const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 8 });
  const owner = createDb(testDb.ownerUrl, { max: 2 });
  return {
    db: app.db,
    owner: owner.db,
    async household(opts = {}) {
      const id = `hh_${randomUUID()}`;
      await owner.db.insert(schema.organization).values({
        id,
        name: 'Test household',
        slug: id,
        createdAt: new Date(),
      });
      await withHousehold(app.db, id, (tx) =>
        tx.insert(schema.householdSettings).values({
          householdId: id,
          locale: opts.locale ?? 'en',
          ...(opts.currency ? { currency: opts.currency } : {}),
        }),
      );
      return { db: app.db, householdId: id, userId: 'user-1', role: opts.role ?? 'owner' };
    },
    async close() {
      await app.pool.end();
      await owner.pool.end();
      await testDb.drop();
    },
  };
}

/** The same household and user with a different role. */
export function withRole(ctx: ServiceCtx, role: ServiceCtx['role']): ServiceCtx {
  return { ...ctx, role };
}
