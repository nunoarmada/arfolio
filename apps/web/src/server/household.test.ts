import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEncryptionKey } from '@arfolio/core/server';
import { createDb, schema, withHousehold, type Db } from '@arfolio/db';
import {
  createAccount,
  deleteInstanceSetting,
  resolveIntegrationConfig,
  setBudgetAlertThresholds,
  setFiscalYearStartMonth,
  setHubAccount,
  writeInstanceSetting,
} from '@arfolio/services';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../packages/db/test/pg.js';
import { createAuth, type Auth } from '../lib/auth';
import { integrationConfigFixture, PASSWORD, signInHeaders, testEnv as env } from '../test-utils';
import {
  AiUnavailableError,
  aiSettings,
  getHouseholdSettings,
  householdSettingsSchema,
  updateHouseholdName,
  updateHouseholdSettings,
} from './household';
import { acceptInvitationAndRegister, hashInvitationToken } from './invitations';
import { ForbiddenError } from './session';
import { completeSetup } from './setup';

const encKey = loadEncryptionKey(env.ENCRYPTION_KEY);

const valid = {
  currency: 'USD',
  locale: 'en',
  timezone: 'America/New_York',
  fiscalYearStartMonth: 4,
  emergencyFundMonths: 9,
  aiEnabled: true,
};

describe('household settings', () => {
  let testDb: TestDb;
  let db: Db;
  let auth: Auth;
  let close: () => Promise<void>;
  let householdId: string;
  let ownerHeaders: Headers;
  let viewerHeaders: Headers;
  const integrations = () => resolveIntegrationConfig(db, encKey, {});

  async function addMember(email: string, role: string): Promise<void> {
    const [owner] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, 'owner@example.com'));
    const id = `inv-${email}`;
    const expiresAt = new Date(Date.now() + 60_000);
    await db
      .insert(schema.invitation)
      .values({ id, organizationId: householdId, email, role, expiresAt, inviterId: owner!.id });
    await db
      .insert(schema.invitationToken)
      .values({ invitationId: id, tokenHash: hashInvitationToken('t'), expiresAt });
    await acceptInvitationAndRegister(
      { invitationId: id, token: 't', name: email, password: PASSWORD },
      { db, auth },
    );
  }

  beforeAll(async () => {
    testDb = await startTestDb();
    const app = createDb(testDb.appUrl(APP_PASSWORD), { max: 4 });
    db = app.db;
    close = () => app.pool.end();
    auth = createAuth({ db, env });
    ({ householdId } = await completeSetup(
      {
        token: env.SETUP_TOKEN,
        name: 'Owner',
        email: 'owner@example.com',
        password: PASSWORD,
        householdName: 'Casa',
        locale: 'pt-PT',
      },
      { db, auth, env },
    ));
    await addMember('viewer@example.com', 'viewer');
    await writeInstanceSetting(db, encKey, 'anthropic.apiKey', 'sk-test', 'owner');
    ownerHeaders = new Headers(await signInHeaders(auth, 'owner@example.com'));
    viewerHeaders = new Headers(await signInHeaders(auth, 'viewer@example.com'));
    // Owners need 2FA to get past requireMember.
    await db
      .update(schema.user)
      .set({ twoFactorEnabled: true })
      .where(eq(schema.user.email, 'owner@example.com'));
  });

  afterAll(async () => {
    await close?.();
    await testDb?.drop();
  });

  it('reads the defaults created by setup', async () => {
    expect(await getHouseholdSettings(ownerHeaders, { db, auth })).toMatchObject({
      currency: 'EUR',
      locale: 'pt-PT',
      timezone: 'UTC',
      fiscalYearStartMonth: 1,
      emergencyFundMonths: 6,
      aiEnabled: false,
      hubAccountId: null,
      budgetAlertThresholds: [80, 100],
    });
  });

  it('reads the hub account and the budget alert thresholds set through the services', async () => {
    const ctx = { db, householdId, userId: 'owner', role: 'owner' as const };
    const hub = await createAccount(ctx, { name: 'Hub', type: 'checking' });
    await setHubAccount(ctx, hub.id);
    await setBudgetAlertThresholds(ctx, [150, 50]);
    expect(await getHouseholdSettings(viewerHeaders, { db, auth })).toMatchObject({
      hubAccountId: hub.id,
      budgetAlertThresholds: [50, 150],
    });
    // The general settings update leaves both untouched.
    await updateHouseholdSettings(ownerHeaders, valid, { db, auth, integrations });
    expect(await getHouseholdSettings(ownerHeaders, { db, auth })).toMatchObject({
      hubAccountId: hub.id,
      budgetAlertThresholds: [50, 150],
    });
    await setHubAccount(ctx, null);
    await withHousehold(db, householdId, (tx) =>
      tx.update(schema.householdSettings).set({ budgetAlertThresholds: [80, 100] }),
    );
  });

  it('lets an owner update every field except the budget year start, which is owned by the budget settings', async () => {
    await updateHouseholdSettings(ownerHeaders, valid, { db, auth, integrations });
    expect(await getHouseholdSettings(ownerHeaders, { db, auth })).toMatchObject({
      ...valid,
      fiscalYearStartMonth: 1,
    });
  });

  it('never writes the budget year start, even when the input carries a different one', async () => {
    const ctx = { db, householdId, userId: 'owner', role: 'owner' as const };
    await setFiscalYearStartMonth(ctx, 7);
    await updateHouseholdSettings(ownerHeaders, valid, { db, auth, integrations });
    expect((await getHouseholdSettings(ownerHeaders, { db, auth })).fiscalYearStartMonth).toBe(7);
    await setFiscalYearStartMonth(ctx, 1);
  });

  it('refuses to turn AI on when no API key is set, and still allows turning it off', async () => {
    await deleteInstanceSetting(db, 'anthropic.apiKey');
    await updateHouseholdSettings(
      ownerHeaders,
      { ...valid, aiEnabled: false },
      { db, auth, integrations },
    );
    await expect(
      updateHouseholdSettings(
        ownerHeaders,
        { ...valid, aiEnabled: true },
        { db, auth, integrations },
      ),
    ).rejects.toBeInstanceOf(AiUnavailableError);
    expect((await getHouseholdSettings(ownerHeaders, { db, auth })).aiEnabled).toBe(false);
    await writeInstanceSetting(db, encKey, 'anthropic.apiKey', 'sk-test', 'owner');
    await updateHouseholdSettings(
      ownerHeaders,
      { ...valid, aiEnabled: true },
      { db, auth, integrations },
    );
    await deleteInstanceSetting(db, 'anthropic.apiKey');
    await updateHouseholdSettings(
      ownerHeaders,
      { ...valid, aiEnabled: false },
      { db, auth, integrations },
    );
    expect((await getHouseholdSettings(ownerHeaders, { db, auth })).aiEnabled).toBe(false);
    await writeInstanceSetting(db, encKey, 'anthropic.apiKey', 'sk-test', 'owner');
    await updateHouseholdSettings(ownerHeaders, valid, { db, auth, integrations });
  });

  it('refuses to turn AI on when the stored key cannot be decrypted', async () => {
    await writeInstanceSetting(db, Buffer.alloc(32, 7), 'anthropic.apiKey', 'sk-other', 'owner');
    await expect(
      updateHouseholdSettings(
        ownerHeaders,
        { ...valid, aiEnabled: true },
        { db, auth, integrations },
      ),
    ).rejects.toBeInstanceOf(AiUnavailableError);
    await writeInstanceSetting(db, encKey, 'anthropic.apiKey', 'sk-test', 'owner');
  });

  it('keeps AI enabling owner-only', async () => {
    await expect(
      updateHouseholdSettings(
        viewerHeaders,
        { ...valid, aiEnabled: true },
        { db, auth, integrations },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('reports AI availability and both model names for the settings page', async () => {
    const on = integrationConfigFixture({ anthropicApiKey: 'sk-test' });
    on.models.categorisation.value = 'claude-test-1';
    on.models.report.value = 'claude-report-1';
    expect(await aiSettings(on)).toEqual({
      aiAvailable: true,
      aiModel: 'claude-test-1',
      aiReportModel: 'claude-report-1',
    });
    expect(await aiSettings(integrationConfigFixture())).toEqual({
      aiAvailable: false,
      aiModel: 'claude-haiku-5-5',
      aiReportModel: 'claude-opus-5-5',
    });
  });

  it('lets a viewer read the settings but not change them (403)', async () => {
    expect(await getHouseholdSettings(viewerHeaders, { db, auth })).toMatchObject({
      currency: 'USD',
    });
    await expect(
      updateHouseholdSettings(viewerHeaders, { ...valid, currency: 'GBP' }, { db, auth }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await getHouseholdSettings(viewerHeaders, { db, auth })).currency).toBe('USD');
  });

  it('lets an owner rename the household; a viewer gets 403', async () => {
    await updateHouseholdName(ownerHeaders, '  Casa Nova ', { db, auth });
    expect((await getHouseholdSettings(viewerHeaders, { db, auth })).name).toBe('Casa Nova');
    await expect(updateHouseholdName(viewerHeaders, 'Hack', { db, auth })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(updateHouseholdName(ownerHeaders, '   ', { db, auth })).rejects.toThrow();
  });

  it('rejects invalid values without touching the row', async () => {
    const bad = [
      { ...valid, currency: 'eur' },
      { ...valid, locale: 'fr' },
      { ...valid, timezone: 'Mars/Olympus' },
      { ...valid, fiscalYearStartMonth: 13 },
      { ...valid, emergencyFundMonths: -1 },
      { ...valid, emergencyFundMonths: 61 },
    ];
    for (const input of bad) {
      expect(householdSettingsSchema.safeParse(input).success).toBe(false);
      await expect(updateHouseholdSettings(ownerHeaders, input, { db, auth })).rejects.toThrow();
    }
    expect(await getHouseholdSettings(ownerHeaders, { db, auth })).toMatchObject({
      ...valid,
      fiscalYearStartMonth: 1,
    });
  });
});
