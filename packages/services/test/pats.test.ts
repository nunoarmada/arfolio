import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withHousehold } from '@arfolio/db';
import {
  createPat,
  ForbiddenError,
  listMyPats,
  NotFoundError,
  recordAudit,
  revokePat,
  ValidationError,
  verifyPat,
  type ServiceCtx,
} from '../src/index.js';
import { startServicesDb, type ServicesTestDb } from './helpers.js';

const { personalAccessToken, auditLog, member } = schema;
const NOW = new Date('2026-10-23T12:00:00Z');
const DAY = 86_400_000;
const USERS = ['user-1', 'alice', 'viewer-1'];

describe('personal access tokens', () => {
  let t: ServicesTestDb;
  let a: ServiceCtx;
  let b: ServiceCtx;

  const as = (ctx: ServiceCtx, userId: string, role: ServiceCtx['role']): ServiceCtx => ({
    ...ctx,
    userId,
    role,
  });
  const join = (ctx: ServiceCtx, userId: string, role: ServiceCtx['role']) =>
    t.owner.insert(member).values({
      id: `m-${ctx.householdId}-${userId}`,
      organizationId: ctx.householdId,
      userId,
      role,
      createdAt: new Date(),
    });
  const patRow = (id: string) =>
    t.owner
      .select()
      .from(personalAccessToken)
      .where(eq(personalAccessToken.id, id))
      .then((r) => r[0]);
  const auditActions = (ctx: ServiceCtx) =>
    t.owner
      .select({
        action: auditLog.action,
        credential: auditLog.credential,
        targetId: auditLog.targetId,
      })
      .from(auditLog)
      .where(eq(auditLog.householdId, ctx.householdId))
      .orderBy(auditLog.createdAt, auditLog.action);

  beforeAll(async () => {
    t = await startServicesDb();
    a = await t.household();
    b = await t.household();
    await t.owner
      .insert(schema.user)
      .values(USERS.map((id) => ({ id, name: id, email: `${id}@example.test` })));
    await join(a, 'user-1', 'owner');
    await join(a, 'alice', 'member');
    await join(a, 'viewer-1', 'viewer');
    await join(b, 'user-1', 'owner');
  });
  afterAll(() => t.close());

  it('creates a token: pfm_pat_ + 32 bytes base64url, 12-char prefix, sha256 only in the DB', async () => {
    const { token, pat } = await createPat(a, { name: 'Claude', scope: 'read', expiresInDays: 90 });
    expect(token).toMatch(/^pfm_pat_[A-Za-z0-9_-]{43}$/);
    expect(pat.prefix).toBe(token.slice(0, 12));
    expect(pat).toMatchObject({ name: 'Claude', scope: 'read', revokedAt: null, lastUsedAt: null });
    expect(Object.keys(pat)).not.toContain('tokenHash');
    const row = await patRow(pat.id);
    expect(row!.tokenHash.equals(createHash('sha256').update(token).digest())).toBe(true);
    expect(row!.expiresAt!.getTime() - row!.createdAt.getTime()).toBeCloseTo(90 * DAY, -4);
  });

  it('the token string appears nowhere in the database', async () => {
    const { token } = await createPat(a, { name: 'Secret', scope: 'read', expiresInDays: null });
    const tables = ['personal_access_token', 'audit_log'];
    for (const table of tables) {
      const { rows } = await t.owner.execute(
        sql`select count(*)::int as n from ${sql.identifier(table)} x where x::text like ${'%' + token + '%'}`,
      );
      expect(rows[0]).toEqual({ n: 0 });
    }
    const body = token.slice(8);
    const { rows } = await t.owner.execute(
      sql`select count(*)::int as n from personal_access_token x where x::text like ${'%' + body + '%'}`,
    );
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('validates input: name 1..60, scope, expiry choices', async () => {
    await expect(
      createPat(a, { name: '', scope: 'read', expiresInDays: 30 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createPat(a, { name: 'x'.repeat(61), scope: 'read', expiresInDays: 30 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createPat(a, { name: 'x', scope: 'admin' as 'read', expiresInDays: 30 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createPat(a, { name: 'x', scope: 'read', expiresInDays: 7 as 30 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('a viewer may create a read token but not read_write', async () => {
    const v = as(a, 'viewer-1', 'viewer');
    await expect(
      createPat(v, { name: 'v', scope: 'read', expiresInDays: 30 }),
    ).resolves.toBeDefined();
    await expect(
      createPat(v, { name: 'v', scope: 'read_write', expiresInDays: 30 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('audits pat.create and pat.revoke with the pat id as target', async () => {
    const ctx = await t.household();
    await t.owner.insert(member).values({
      id: `m-${ctx.householdId}`,
      organizationId: ctx.householdId,
      userId: 'user-1',
      role: 'owner',
      createdAt: new Date(),
    });
    const { pat } = await createPat(ctx, { name: 'Audited', scope: 'read', expiresInDays: 30 });
    await revokePat(ctx, pat.id);
    expect(await auditActions(ctx)).toEqual([
      { action: 'pat.create', credential: null, targetId: pat.id },
      { action: 'pat.revoke', credential: null, targetId: pat.id },
    ]);
    const [row] = await t.owner
      .select()
      .from(auditLog)
      .where(eq(auditLog.householdId, ctx.householdId));
    expect(row).toMatchObject({ actor: 'web', targetType: 'pat', userId: 'user-1' });
  });

  it('lists only the caller own tokens, without hashes', async () => {
    const ctx = await t.household();
    const alice = as(ctx, 'alice', 'member');
    await createPat(ctx, { name: 'mine-1', scope: 'read', expiresInDays: 30 });
    await createPat(alice, { name: 'alice-1', scope: 'read', expiresInDays: 30 });
    const mine = await listMyPats(ctx);
    expect(mine.map((p) => p.name)).toEqual(['mine-1']);
    expect(Object.keys(mine[0]!)).not.toContain('tokenHash');
    expect((await listMyPats(alice)).map((p) => p.name)).toEqual(['alice-1']);
  });

  it('revokes own tokens only, idempotently, and audits once', async () => {
    const ctx = await t.household();
    const alice = as(ctx, 'alice', 'member');
    const { pat } = await createPat(ctx, { name: 'r', scope: 'read', expiresInDays: 30 });
    await expect(revokePat(alice, pat.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await patRow(pat.id))!.revokedAt).toBeNull();
    await revokePat(ctx, pat.id);
    const first = (await patRow(pat.id))!.revokedAt;
    expect(first).not.toBeNull();
    await revokePat(ctx, pat.id);
    expect((await patRow(pat.id))!.revokedAt).toEqual(first);
    expect((await auditActions(ctx)).filter((r) => r.action === 'pat.revoke')).toHaveLength(1);
    await expect(revokePat(ctx, 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundError);
    await expect(revokePat(ctx, '00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('rolls the audit row back with the transaction that wrote it', async () => {
    const ctx = await t.household();
    await expect(
      withHousehold(t.db, ctx.householdId, async (tx) => {
        await recordAudit(tx, ctx, {
          actor: 'mcp',
          action: 'test.rollback',
          targetType: 'thing',
          targetId: 'x',
          credential: 'pat:abc',
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await auditActions(ctx)).toEqual([]);
    await withHousehold(t.db, ctx.householdId, (tx) =>
      recordAudit(tx, ctx, { actor: 'mcp', action: 'test.commit', credential: 'pat:abc' }),
    );
    expect(await auditActions(ctx)).toEqual([
      { action: 'test.commit', credential: 'pat:abc', targetId: null },
    ]);
  });

  describe('verifyPat', () => {
    it('resolves a valid token to household, user, role and scopes', async () => {
      const { token, pat } = await createPat(a, {
        name: 'ok',
        scope: 'read_write',
        expiresInDays: 30,
      });
      const got = await verifyPat(t.db, token, NOW);
      expect(got).toEqual({
        patId: pat.id,
        householdId: a.householdId,
        userId: 'user-1',
        role: 'owner',
        scopes: new Set(['pfm:read', 'pfm:write']),
      });
      const { token: ro } = await createPat(a, { name: 'ro', scope: 'read', expiresInDays: null });
      expect((await verifyPat(t.db, ro, NOW))!.scopes).toEqual(new Set(['pfm:read']));
    });

    it('returns null for a malformed token, wrong prefix, unknown hash', async () => {
      const { token } = await createPat(a, { name: 'x', scope: 'read', expiresInDays: 30 });
      expect(await verifyPat(t.db, '', NOW)).toBeNull();
      expect(await verifyPat(t.db, 'Bearer nope', NOW)).toBeNull();
      expect(await verifyPat(t.db, token.replace('pfm_pat_', 'pfm_xxx_'), NOW)).toBeNull();
      expect(
        await verifyPat(t.db, `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, NOW),
      ).toBeNull();
      expect(await verifyPat(t.db, 'pfm_pat_' + 'A'.repeat(43), NOW)).toBeNull();
    });

    it('returns null for a revoked token', async () => {
      const { token, pat } = await createPat(a, { name: 'rev', scope: 'read', expiresInDays: 30 });
      expect(await verifyPat(t.db, token, NOW)).not.toBeNull();
      await revokePat(a, pat.id);
      expect(await verifyPat(t.db, token, NOW)).toBeNull();
    });

    it('returns null once expired, valid just before', async () => {
      const { token, pat } = await createPat(a, { name: 'exp', scope: 'read', expiresInDays: 30 });
      const exp = (await patRow(pat.id))!.expiresAt!;
      expect(await verifyPat(t.db, token, new Date(exp.getTime() - 1))).not.toBeNull();
      expect(await verifyPat(t.db, token, exp)).toBeNull();
      expect(await verifyPat(t.db, token, new Date(exp.getTime() + DAY))).toBeNull();
    });

    it('returns null for a user who is no longer a member (and the member delete drops the PATs)', async () => {
      const ctx = await t.household();
      const carol = as(ctx, 'alice', 'member');
      await join(ctx, 'alice', 'member');
      const { token, pat } = await createPat(carol, {
        name: 'c',
        scope: 'read',
        expiresInDays: 30,
      });
      expect(await verifyPat(t.db, token, NOW)).not.toBeNull();
      await t.owner
        .delete(member)
        .where(and(eq(member.organizationId, ctx.householdId), eq(member.userId, 'alice')));
      expect(await verifyPat(t.db, token, NOW)).toBeNull();
      expect(await patRow(pat.id)).toBeUndefined();
    });

    it('the member removal cascade only drops that household tokens of that user', async () => {
      const ctx = await t.household();
      const other = await t.household();
      await join(ctx, 'alice', 'member');
      await join(other, 'alice', 'member');
      const mine = await createPat(as(ctx, 'alice', 'member'), {
        name: 'm',
        scope: 'read',
        expiresInDays: 30,
      });
      const theirs = await createPat(as(other, 'alice', 'member'), {
        name: 't',
        scope: 'read',
        expiresInDays: 30,
      });
      await t.owner
        .delete(member)
        .where(and(eq(member.organizationId, ctx.householdId), eq(member.userId, 'alice')));
      expect(await patRow(mine.pat.id)).toBeUndefined();
      expect(await patRow(theirs.pat.id)).toBeDefined();
    });

    it('deleting the user deletes the PATs', async () => {
      const ctx = await t.household();
      await t.owner
        .insert(schema.user)
        .values({ id: 'temp-u', name: 't', email: 'temp-u@example.test' });
      await join(ctx, 'temp-u', 'member');
      const { pat } = await createPat(as(ctx, 'temp-u', 'member'), {
        name: 'd',
        scope: 'read',
        expiresInDays: 30,
      });
      await t.owner.delete(schema.user).where(eq(schema.user.id, 'temp-u'));
      expect(await patRow(pat.id)).toBeUndefined();
    });

    it('re-reads the role: a viewer read_write token is reduced to pfm:read; a demotion applies at once', async () => {
      const ctx = await t.household();
      await join(ctx, 'alice', 'member');
      const alice = as(ctx, 'alice', 'member');
      const { token } = await createPat(alice, {
        name: 'w',
        scope: 'read_write',
        expiresInDays: 30,
      });
      expect((await verifyPat(t.db, token, NOW))!.scopes).toEqual(
        new Set(['pfm:read', 'pfm:write']),
      );
      await t.owner
        .update(member)
        .set({ role: 'viewer' })
        .where(and(eq(member.organizationId, ctx.householdId), eq(member.userId, 'alice')));
      const demoted = await verifyPat(t.db, token, NOW);
      expect(demoted).toMatchObject({ role: 'viewer', scopes: new Set(['pfm:read']) });
    });

    it('throttles last_used_at to once per 60 seconds', async () => {
      const { token, pat } = await createPat(a, { name: 'lu', scope: 'read', expiresInDays: 30 });
      expect((await patRow(pat.id))!.lastUsedAt).toBeNull();
      await verifyPat(t.db, token, NOW);
      expect((await patRow(pat.id))!.lastUsedAt).toEqual(NOW);
      await verifyPat(t.db, token, new Date(NOW.getTime() + 30_000));
      expect((await patRow(pat.id))!.lastUsedAt).toEqual(NOW);
      const later = new Date(NOW.getTime() + 61_000);
      await verifyPat(t.db, token, later);
      expect((await patRow(pat.id))!.lastUsedAt).toEqual(later);
    });

    it('does not bump last_used_at for a token that fails verification', async () => {
      const { token, pat } = await createPat(a, { name: 'nb', scope: 'read', expiresInDays: 30 });
      await revokePat(a, pat.id);
      await verifyPat(t.db, token, NOW);
      expect((await patRow(pat.id))!.lastUsedAt).toBeNull();
    });
  });

  it('keeps tokens of two households apart: B cannot list or revoke A tokens', async () => {
    const { pat } = await createPat(a, { name: 'isolated', scope: 'read', expiresInDays: 30 });
    expect((await listMyPats(b)).map((p) => p.id)).not.toContain(pat.id);
    await expect(revokePat(b, pat.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
