import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, withHousehold, type Db } from '../src/index.js';
import { APP_PASSWORD, startTestDb, type TestDb } from './pg.js';

async function pgError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error && err.cause instanceof Error ? err.cause.message : String(err);
  }
  throw new Error('expected the query to be rejected');
}

const TABLES = ['advisor_message', 'advisor_proposal', 'advisor_note', 'advisor_member_settings'];

describe('advisor tables (as pfm_app)', () => {
  let testDb: TestDb;
  let db: Db;
  let close: () => Promise<void>;
  const messageIds: Record<string, string> = {};

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 2 });
    db = app.db;
    close = () => app.pool.end();
    await db
      .insert(schema.organization)
      .values(['hA', 'hB'].map((id) => ({ id, name: id, slug: id, createdAt: new Date() })));
    const owner = createDb(testDb.ownerUrl, { max: 1 });
    await owner.db
      .insert(schema.user)
      .values({ id: 'u', name: 'U', email: 'u@example.com', createdAt: new Date() });
    await owner.pool.end();
    for (const h of ['hA', 'hB']) {
      await withHousehold(db, h, async (tx) => {
        const [m] = await tx
          .insert(schema.advisorMessage)
          .values({ householdId: h, userId: 'u', role: 'user', origin: 'chat', text: 'hi' })
          .returning({ id: schema.advisorMessage.id });
        messageIds[h] = m!.id;
        await tx.insert(schema.advisorProposal).values({
          householdId: h,
          userId: 'u',
          messageId: m!.id,
          kind: 'goal_create',
          payload: {},
        });
        await tx.insert(schema.advisorNote).values({ householdId: h, userId: 'u', text: 'n' });
        await tx.insert(schema.advisorMemberSettings).values({ householdId: h, userId: 'u' });
      });
    }
  });
  afterAll(async () => {
    await close?.();
    await testDb?.drop();
  });

  it.each(TABLES)('%s has RLS enabled with the household_isolation policy', async (table) => {
    const { rows } = await db.execute(
      sql`select c.relrowsecurity as rls, (select count(*)::int from pg_policies p
          where p.tablename = c.relname and p.policyname = 'household_isolation') as policies
          from pg_class c where c.relname = ${table} and c.relnamespace = 'public'::regnamespace`,
    );
    expect(rows[0]).toMatchObject({ rls: true, policies: 1 });
  });

  it('shows each household only its own rows and refuses cross-household writes', async () => {
    const seen = await withHousehold(db, 'hA', async (tx) => ({
      messages: await tx.select().from(schema.advisorMessage),
      proposals: await tx.select().from(schema.advisorProposal),
      notes: await tx.select().from(schema.advisorNote),
      settings: await tx.select().from(schema.advisorMemberSettings),
    }));
    expect(seen.messages.map((r) => r.householdId)).toEqual(['hA']);
    expect(seen.proposals.map((r) => r.householdId)).toEqual(['hA']);
    expect(seen.notes.map((r) => r.householdId)).toEqual(['hA']);
    expect(seen.settings.map((r) => r.householdId)).toEqual(['hA']);

    const removed = await withHousehold(db, 'hA', (tx) =>
      tx
        .delete(schema.advisorMessage)
        .where(eq(schema.advisorMessage.id, messageIds.hB!))
        .returning(),
    );
    expect(removed).toEqual([]);
    const message = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx.insert(schema.advisorNote).values({ householdId: 'hB', userId: 'u', text: 'smuggled' }),
      ),
    );
    expect(message).toMatch(/row-level security/i);
    expect(await db.select().from(schema.advisorMessage)).toEqual([]);
  });

  it('rejects out-of-range values', async () => {
    const note = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx
          .insert(schema.advisorNote)
          .values({ householdId: 'hA', userId: 'u', text: 'x'.repeat(501) }),
      ),
    );
    expect(note).toMatch(/advisor_note_text_check/);
    const cap = await pgError(
      withHousehold(db, 'hA', (tx) =>
        tx
          .update(schema.advisorMemberSettings)
          .set({ weeklyCap: 15 })
          .where(eq(schema.advisorMemberSettings.householdId, 'hA')),
      ),
    );
    expect(cap).toMatch(/weekly_cap_check/);
  });
});
