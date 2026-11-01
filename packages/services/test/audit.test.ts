import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withHousehold } from '@arfolio/db';
import {
  ForbiddenError,
  listAudit,
  recordAudit,
  ValidationError,
  type ServiceCtx,
} from '../src/index.js';
import { startServicesDb, withRole, type ServicesTestDb } from './helpers.js';

const { auditLog } = schema;

describe('audit log', () => {
  let t: ServicesTestDb;
  let a: ServiceCtx;
  let b: ServiceCtx;

  const write = (ctx: ServiceCtx, action: string, extra: { targetId?: string } = {}) =>
    withHousehold(t.db, ctx.householdId, (tx) =>
      recordAudit(tx, ctx, {
        actor: 'mcp',
        action,
        targetType: 'transaction',
        credential: 'pat:p1',
        ...extra,
      }),
    );

  beforeAll(async () => {
    t = await startServicesDb();
    a = await t.household();
    b = await t.household();
    await t.owner.insert(schema.user).values({ id: 'user-1', name: 'u', email: 'u@example.test' });
  });
  afterAll(() => t.close());

  it('records actor, action, target, credential and the acting user', async () => {
    await write(a, 'transaction.categorise', { targetId: 'tx-1' });
    const [row] = await t.owner
      .select()
      .from(auditLog)
      .where(eq(auditLog.householdId, a.householdId));
    expect(row).toMatchObject({
      actor: 'mcp',
      action: 'transaction.categorise',
      targetType: 'transaction',
      targetId: 'tx-1',
      credential: 'pat:p1',
      userId: 'user-1',
    });
  });

  it('is for owners only', async () => {
    await expect(listAudit(withRole(a, 'member'), { limit: 10 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(listAudit(withRole(a, 'viewer'), { limit: 10 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('lists newest first in keyset pages and only this household', async () => {
    const ctx = await t.household();
    for (let i = 0; i < 5; i++) await write(ctx, `act.${i}`);
    await write(b, 'other.household');
    const p1 = await listAudit(ctx, { limit: 2 });
    expect(p1.items.map((r) => r.action)).toEqual(['act.4', 'act.3']);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await listAudit(ctx, { limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((r) => r.action)).toEqual(['act.2', 'act.1']);
    const p3 = await listAudit(ctx, { limit: 2, cursor: p2.nextCursor! });
    expect(p3.items.map((r) => r.action)).toEqual(['act.0']);
    expect(p3.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor', async () => {
    await expect(listAudit(a, { limit: 10, cursor: 'nonsense' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('is append-only for the app role: no update, no delete', async () => {
    await write(a, 'immutable');
    const err = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        const cause = (e as Error).cause;
        return cause instanceof Error ? cause.message : String(e);
      }
      return 'no error';
    };
    expect(
      await err(
        withHousehold(t.db, a.householdId, (tx) => tx.update(auditLog).set({ action: 'tampered' })),
      ),
    ).toMatch(/permission denied/);
    expect(await err(withHousehold(t.db, a.householdId, (tx) => tx.delete(auditLog)))).toMatch(
      /permission denied/,
    );
  });
});
