import { randomUUID } from 'node:crypto';
import { createDb, schema, withHousehold, type Db } from '@arfolio/db';
import type { ServiceCtx } from '@arfolio/services';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../packages/db/test/pg.js';

export interface AdvisorTestDb {
  /** Connection as `pfm_app`, so RLS applies. */
  db: Db;
  /** Connection as the table owner, for arranging and inspecting data. */
  owner: Db;
  household(opts?: { aiEnabled?: boolean }): Promise<string>;
  /** A real member (advisor rows have a foreign key to the user) of the household. */
  member(householdId: string, role?: ServiceCtx['role']): Promise<ServiceCtx>;
  close(): Promise<void>;
}

/** One migrated throwaway database for a web test file that exercises the advisor. */
export async function startAdvisorTestDb(): Promise<AdvisorTestDb> {
  const testDb: TestDb = await startTestDb();
  const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 6 });
  const owner = createDb(testDb.ownerUrl, { max: 2 });
  return {
    db: app.db,
    owner: owner.db,
    async household(opts = {}) {
      const id = `hh_${randomUUID()}`;
      await owner.db
        .insert(schema.organization)
        .values({ id, name: 'Test household', slug: id, createdAt: new Date() });
      await withHousehold(app.db, id, (tx) =>
        tx.insert(schema.householdSettings).values({
          householdId: id,
          locale: 'en',
          currency: 'EUR',
          aiEnabled: opts.aiEnabled ?? true,
        }),
      );
      return id;
    },
    async member(householdId, role = 'owner') {
      const id = `u_${randomUUID()}`;
      await owner.db
        .insert(schema.user)
        .values({ id, name: 'Member', email: `${id}@example.com`, createdAt: new Date() });
      return { db: app.db, householdId, userId: id, role };
    },
    async close() {
      await app.pool.end();
      await owner.pool.end();
      await testDb.drop();
    },
  };
}
