import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, schema, type Db } from '@arfolio/db';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { createAuth, type Auth } from '../lib/auth';
import { PASSWORD, testEnv as env } from '../test-utils';
import { getInvitationPreview, hashInvitationToken } from './invitations';
import { completeSetup, isValidSetupToken } from './setup';

describe('invite preview and setup token helpers', () => {
  let testDb: TestDb;
  let db: Db;
  let auth: Auth;
  let close: () => Promise<void>;
  let householdId: string;
  let ownerId: string;

  async function invite(id: string, patch: Partial<typeof schema.invitation.$inferInsert> = {}) {
    const expiresAt = new Date(Date.now() + 60_000);
    await db.insert(schema.invitation).values({
      id,
      organizationId: householdId,
      email: `${id}@example.com`,
      role: 'member',
      expiresAt,
      inviterId: ownerId,
      ...patch,
    });
    await db
      .insert(schema.invitationToken)
      .values({ invitationId: id, tokenHash: hashInvitationToken('secret'), expiresAt });
  }

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 4 });
    db = app.db;
    close = () => app.pool.end();
    auth = createAuth({ db, env });
    const done = await completeSetup(
      {
        token: env.SETUP_TOKEN,
        name: 'Ana Owner',
        email: 'owner@example.com',
        password: PASSWORD,
        householdName: 'Casa Exemplo',
        locale: 'pt-PT',
      },
      { db, auth, env },
    );
    householdId = done.householdId;
    ownerId = done.userId;
  });

  afterAll(async () => {
    await close?.();
    await testDb?.drop();
  });

  it('describes a pending invitation to the holder of its token', async () => {
    await invite('ok');
    await expect(getInvitationPreview('ok', 'secret', { db })).resolves.toMatchObject({
      email: 'ok@example.com',
      role: 'member',
      householdName: 'Casa Exemplo',
      inviterName: 'Ana Owner',
    });
  });

  it('returns null for a wrong token, an unknown id, and an empty token', async () => {
    await invite('wrong');
    expect(await getInvitationPreview('wrong', 'nope', { db })).toBeNull();
    expect(await getInvitationPreview('missing', 'secret', { db })).toBeNull();
    expect(await getInvitationPreview('wrong', '', { db })).toBeNull();
  });

  it('returns null for revoked, accepted and expired invitations alike', async () => {
    await invite('revoked', { status: 'canceled' });
    await invite('accepted', { status: 'accepted' });
    await invite('expired', { expiresAt: new Date(Date.now() - 1000) });
    for (const id of ['revoked', 'accepted', 'expired']) {
      expect(await getInvitationPreview(id, 'secret', { db })).toBeNull();
    }
  });

  it('stops describing an invitation once its token has been used', async () => {
    await invite('used');
    await db
      .update(schema.invitationToken)
      .set({ usedAt: new Date() })
      .where(eq(schema.invitationToken.invitationId, 'used'));
    expect(await getInvitationPreview('used', 'secret', { db })).toBeNull();
  });

  it('checks the setup token without throwing on bad input', () => {
    expect(isValidSetupToken(env.SETUP_TOKEN, env)).toBe(true);
    expect(isValidSetupToken('x', env)).toBe(false);
    expect(isValidSetupToken(undefined, env)).toBe(false);
    expect(isValidSetupToken(['a'], env)).toBe(false);
  });
});
