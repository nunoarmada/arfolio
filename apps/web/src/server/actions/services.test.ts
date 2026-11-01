import { generateKeyPairSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEncryptionKey } from '@arfolio/core/server';
import { ProviderAuthError } from '@arfolio/connectors';
import { createDb, schema, withHousehold, type Db } from '@arfolio/db';
import {
  deleteInstanceSetting,
  readInstanceSettings,
  writeInstanceSetting,
  type InstanceSettingKey,
} from '@arfolio/services';
import { APP_PASSWORD, startTestDb, type TestDb } from '../../../../../packages/db/test/pg.js';
import { createAuth, type Auth } from '../../lib/auth';
import { signInHeaders, testEnv as env } from '../../test-utils';
import { acceptInvitationAndRegister, hashInvitationToken } from '../invitations';
import {
  loadServicesView,
  removeSetting,
  runServiceTest,
  saveSetting,
  SERVICE_KEYS,
  type ServiceSettingsDeps,
} from '../service-settings';
import { completeSetup } from '../setup';
import { run } from './result';

const encKey = loadEncryptionKey(env.ENCRYPTION_KEY);
const SECRET = 'sk-secret-value';
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

describe('services settings actions', () => {
  let testDb: TestDb;
  let db: Db;
  let auth: Auth;
  let close: () => Promise<void>;
  let householdId: string;
  let owner: Headers;
  let member: Headers;
  let viewer: Headers;
  let deps: ServiceSettingsDeps;

  const depsWith = (over: Partial<ServiceSettingsDeps> = {}): ServiceSettingsDeps => ({
    ...deps,
    ...over,
  });
  const stored = async (key: InstanceSettingKey) => (await readInstanceSettings(db, encKey))[key];
  // The audit log is append-only, so each test looks at the rows added since it started.
  let auditBaseline = new Set<string>();
  const allAuditRows = () =>
    withHousehold(db, householdId, (tx) => tx.select().from(schema.auditLog));
  const auditRows = async () =>
    (await allAuditRows())
      .filter((r) => !auditBaseline.has(r.id))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  async function addMember(email: string, role: string): Promise<void> {
    const [ownerUser] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, 'owner@example.com'));
    const id = `inv-${email}`;
    const expiresAt = new Date(Date.now() + 60_000);
    await db.insert(schema.invitation).values({
      id,
      organizationId: householdId,
      email,
      role,
      expiresAt,
      inviterId: ownerUser!.id,
    });
    await db
      .insert(schema.invitationToken)
      .values({ invitationId: id, tokenHash: hashInvitationToken('t'), expiresAt });
    await acceptInvitationAndRegister(
      { invitationId: id, token: 't', name: email, password: 'correct-horse-battery' },
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
        password: 'correct-horse-battery',
        householdName: 'Casa',
        locale: 'pt-PT',
      },
      { db, auth, env },
    ));
    await addMember('member@example.com', 'member');
    await addMember('viewer@example.com', 'viewer');
    owner = new Headers(await signInHeaders(auth, 'owner@example.com'));
    member = new Headers(await signInHeaders(auth, 'member@example.com'));
    viewer = new Headers(await signInHeaders(auth, 'viewer@example.com'));
    // Owners need 2FA to get past requireMember.
    await db
      .update(schema.user)
      .set({ twoFactorEnabled: true })
      .where(eq(schema.user.email, 'owner@example.com'));
    deps = {
      db,
      encryptionKey: encKey,
      env: {},
      appUrl: 'https://pfm.example.test',
      brandName: 'Testbrand',
      session: { db, auth },
    };
  });

  beforeEach(async () => {
    for (const key of SERVICE_KEYS) await deleteInstanceSetting(db, key);
    auditBaseline = new Set((await allAuditRows()).map((r) => r.id));
  });

  afterAll(async () => {
    await close?.();
    await testDb?.drop();
  });

  it('owner saves and the value is not echoed', async () => {
    const result = await run(() =>
      saveSetting(owner, { key: 'anthropic.apiKey', value: SECRET }, deps),
    );
    expect(result).toEqual({ ok: true, data: null });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    // Stored, encrypted: the decrypted read returns it, the raw column does not hold it.
    expect(await stored('anthropic.apiKey')).toMatchObject({ value: SECRET });
    const [row] = await db.select().from(schema.instanceSecret);
    expect(row?.value).not.toContain(SECRET);

    const view = await loadServicesView(owner, deps);
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(view.fields['anthropic.apiKey']).toMatchObject({
      source: 'db',
      configured: true,
      unreadable: false,
      invalid: false,
    });
    expect(view.fields['anthropic.apiKey']).not.toHaveProperty('value');
  });

  it('shows non-secret values and withholds every secret one', async () => {
    await saveSetting(owner, { key: 'ai.reportModel', value: 'claude-test-model' }, deps);
    await saveSetting(
      owner,
      { key: 'smtp.url', value: 'smtp://user:hunter2@mail.example.test' },
      deps,
    );
    await saveSetting(owner, { key: 'enableBanking.privateKey', value: PEM }, deps);
    const view = await loadServicesView(owner, deps);
    expect(view.fields['ai.reportModel']).toMatchObject({
      source: 'db',
      value: 'claude-test-model',
    });
    expect(view.fields['ai.categorisationModel']).toMatchObject({
      source: 'default',
      configured: false,
    });
    expect(view.fields['ai.categorisationModel']?.value).toBeTruthy();
    for (const key of ['smtp.url', 'enableBanking.privateKey', 'anthropic.apiKey'] as const) {
      expect(view.fields[key]).not.toHaveProperty('value');
    }
    expect(JSON.stringify(view)).not.toContain('hunter2');
    expect(JSON.stringify(view)).not.toContain('PRIVATE KEY');
    expect(view.callbackUrl).toBe('https://pfm.example.test/api/connections/callback');
  });

  it('member and viewer are rejected', async () => {
    for (const headers of [member, viewer]) {
      expect(
        await run(() => saveSetting(headers, { key: 'anthropic.apiKey', value: SECRET }, deps)),
      ).toEqual({ ok: false, code: 'forbidden' });
      expect(await run(() => removeSetting(headers, { key: 'anthropic.apiKey' }, deps))).toEqual({
        ok: false,
        code: 'forbidden',
      });
      expect(await run(() => runServiceTest(headers, { service: 'anthropic' }, deps))).toEqual({
        ok: false,
        code: 'forbidden',
      });
    }
    expect(await stored('anthropic.apiKey')).toBeUndefined();
    expect(await auditRows()).toHaveLength(0);
  });

  it('env-sourced key cannot be saved or removed', async () => {
    await writeInstanceSetting(db, encKey, 'anthropic.apiKey', 'sk-old', 'owner');
    const withEnv = depsWith({ env: { ANTHROPIC_API_KEY: 'sk-from-env' } });
    expect(
      await run(() => saveSetting(owner, { key: 'anthropic.apiKey', value: SECRET }, withEnv)),
    ).toEqual({ ok: false, code: 'conflict', conflict: 'set_by_environment' });
    expect(await run(() => removeSetting(owner, { key: 'anthropic.apiKey' }, withEnv))).toEqual({
      ok: false,
      code: 'conflict',
      conflict: 'set_by_environment',
    });
    // Untouched, and nothing audited.
    expect(await stored('anthropic.apiKey')).toMatchObject({ value: 'sk-old' });
    expect(await auditRows()).toHaveLength(0);
    const view = await loadServicesView(owner, withEnv);
    expect(view.fields['anthropic.apiKey']).toMatchObject({ source: 'env', configured: true });
    expect(JSON.stringify(view)).not.toContain('sk-from-env');
  });

  it('invalid values are rejected and nothing is stored', async () => {
    const bad: Array<[InstanceSettingKey, string]> = [
      ['enableBanking.apiUrl', 'http://example.com'],
      ['enableBanking.apiUrl', 'not a url'],
      ['enableBanking.privateKey', 'not a pem'],
      [
        'ai.valuationPortals',
        JSON.stringify({ property: ['bad host!'], vehicle: [], classifieds: [] }),
      ],
      ['ai.valuationPortals', 'not json'],
      ['smtp.url', 'http://mail.example.test'],
      ['smtp.url', 'smtp://mail.example.test:587?sendmail=true&path=/bin/sh'],
      ['smtp.url', 'smtps://mail.example.test#frag'],
      ['anthropic.apiKey', '   '],
      ['ai.reportModel', ''],
    ];
    for (const [key, value] of bad) {
      const result = await run(() => saveSetting(owner, { key, value }, deps));
      expect(result, `${key}=${value}`).toMatchObject({
        ok: false,
        code: 'validation',
        fields: [key],
      });
      expect(JSON.stringify(result)).not.toContain(value.trim() || 'never-empty');
      expect(await stored(key)).toBeUndefined();
    }
    expect(
      await run(() => saveSetting(owner, { key: 'nope' as InstanceSettingKey, value: 'x' }, deps)),
    ).toMatchObject({ ok: false, code: 'validation' });
    expect(await auditRows()).toHaveLength(0);
  });

  it('accepts a loopback http URL, canonical portals and a PEM with literal \\n', async () => {
    const portals = { property: ['idealista.pt'], vehicle: ['olx.pt'], classifieds: [] };
    for (const [key, value] of [
      ['enableBanking.apiUrl', 'http://127.0.0.1:4010'],
      ['ai.valuationPortals', JSON.stringify(portals)],
      ['enableBanking.privateKey', PEM.trim().replace(/\n/g, '\\n')],
    ] as const) {
      expect(await run(() => saveSetting(owner, { key, value }, deps))).toEqual({
        ok: true,
        data: null,
      });
    }
    expect(await stored('enableBanking.privateKey')).toMatchObject({ value: PEM.trim() });
    const view = await loadServicesView(owner, deps);
    expect(JSON.parse(view.fields['ai.valuationPortals']!.value!)).toEqual(portals);
  });

  it('audit row records key name only', async () => {
    await saveSetting(owner, { key: 'anthropic.apiKey', value: SECRET }, deps);
    await removeSetting(owner, { key: 'anthropic.apiKey' }, deps);
    const rows = await auditRows();
    expect(rows.map((r) => [r.action, r.targetType, r.targetId, r.actor])).toEqual([
      ['instance_setting.update', 'instance_setting', 'anthropic.apiKey', 'web'],
      ['instance_setting.remove', 'instance_setting', 'anthropic.apiKey', 'web'],
    ]);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(await stored('anthropic.apiKey')).toBeUndefined();
  });

  it('unreadable value surfaces as unreadable in the view model', async () => {
    await writeInstanceSetting(db, encKey, 'anthropic.apiKey', SECRET, 'owner');
    const otherKey = loadEncryptionKey('fedcba9876543210'.repeat(4));
    const view = await loadServicesView(owner, depsWith({ encryptionKey: otherKey }));
    expect(view.fields['anthropic.apiKey']).toMatchObject({
      source: 'unset',
      configured: false,
      unreadable: true,
    });
    expect(JSON.stringify(view)).not.toContain(SECRET);
    // It can be replaced even though it cannot be read.
    expect(
      await run(() =>
        saveSetting(
          owner,
          { key: 'anthropic.apiKey', value: 'sk-new' },
          depsWith({ encryptionKey: otherKey }),
        ),
      ),
    ).toEqual({ ok: true, data: null });
  });

  it('a stored value that fails validation is reported as invalid', async () => {
    await writeInstanceSetting(db, encKey, 'enableBanking.apiUrl', 'http://example.com', 'owner');
    const view = await loadServicesView(owner, deps);
    expect(view.fields['enableBanking.apiUrl']).toMatchObject({ source: 'default', invalid: true });
  });

  it('a stale session gets the reauth code for save, remove and test, and nothing is stored', async () => {
    const [user] = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, 'owner@example.com'));
    const setCreated = (at: Date) =>
      db.update(schema.session).set({ createdAt: at }).where(eq(schema.session.userId, user!.id));
    await setCreated(new Date(Date.now() - 11 * 60_000));
    try {
      const reauth = { ok: false, code: 'reauth' };
      expect(
        await run(() => saveSetting(owner, { key: 'anthropic.apiKey', value: SECRET }, deps)),
      ).toEqual(reauth);
      expect(await run(() => removeSetting(owner, { key: 'anthropic.apiKey' }, deps))).toEqual(
        reauth,
      );
      expect(await run(() => runServiceTest(owner, { service: 'anthropic' }, deps))).toEqual(
        reauth,
      );
      expect(await stored('anthropic.apiKey')).toBeUndefined();
    } finally {
      await setCreated(new Date());
    }
  });

  describe('test actions', () => {
    it('anthropic: uses the configured key and reports a fixed code, never the SDK text', async () => {
      const ping = vi.fn(async () => ({ ok: false as const, reason: 'invalid_key' as const }));
      expect(
        await run(() => runServiceTest(owner, { service: 'anthropic' }, depsWith({ ping }))),
      ).toEqual({
        ok: true,
        data: { ok: false, message: 'not_configured' },
      });
      await writeInstanceSetting(db, encKey, 'anthropic.apiKey', SECRET, 'owner');
      const result = await run(() =>
        runServiceTest(owner, { service: 'anthropic' }, depsWith({ ping })),
      );
      expect(ping).toHaveBeenCalledWith(SECRET);
      expect(result).toEqual({ ok: true, data: { ok: false, message: 'invalid_key' } });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it('bank: lists banks with a client built from the resolved config', async () => {
      await writeInstanceSetting(db, encKey, 'enableBanking.appId', 'app-1', 'owner');
      await writeInstanceSetting(db, encKey, 'enableBanking.privateKey', PEM, 'owner');
      const listAspsps = vi.fn(async () => []);
      const createBankClient = vi.fn(() => ({ listAspsps }));
      const ok = await run(() =>
        runServiceTest(owner, { service: 'enableBanking' }, depsWith({ createBankClient })),
      );
      expect(ok).toEqual({ ok: true, data: { ok: true, message: 'ok' } });
      expect(createBankClient).toHaveBeenCalledWith({
        appId: 'app-1',
        privateKeyPem: PEM,
        baseUrl: 'https://api.enablebanking.com',
      });
      expect(listAspsps).toHaveBeenCalledWith('FI');

      const rejecting = vi.fn(() => ({
        listAspsps: async () => {
          throw new ProviderAuthError(`bad key ${PEM}`);
        },
      }));
      const rejected = await run(() =>
        runServiceTest(
          owner,
          { service: 'enableBanking' },
          depsWith({ createBankClient: rejecting }),
        ),
      );
      expect(rejected).toEqual({ ok: true, data: { ok: false, message: 'rejected' } });
    });

    it('bank: not configured without credentials', async () => {
      expect(await run(() => runServiceTest(owner, { service: 'enableBanking' }, deps))).toEqual({
        ok: true,
        data: { ok: false, message: 'not_configured' },
      });
    });

    it('smtp: verifies, then mails the owner; failures are fixed codes', async () => {
      await writeInstanceSetting(db, encKey, 'smtp.url', 'smtp://u:pw@mail.example.test', 'owner');
      const sendMail = vi.fn(async () => undefined);
      const good = { verify: vi.fn(async () => true), sendMail };
      const createTransport = vi.fn(() => good);
      expect(
        await run(() => runServiceTest(owner, { service: 'smtp' }, depsWith({ createTransport }))),
      ).toEqual({ ok: true, data: { ok: true, message: 'mail_sent' } });
      // Explicit options only: the raw URL (and anything it could smuggle in) never reaches nodemailer.
      expect(createTransport).toHaveBeenCalledWith({
        host: 'mail.example.test',
        port: 587,
        secure: false,
        auth: { user: 'u', pass: 'pw' },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 10_000,
      });
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@example.com' }));

      const unverifiable = {
        verify: async () => {
          throw new Error('auth failed for u:pw');
        },
        sendMail,
      };
      const failed = await run(() =>
        runServiceTest(
          owner,
          { service: 'smtp' },
          depsWith({ createTransport: () => unverifiable }),
        ),
      );
      expect(failed).toEqual({ ok: true, data: { ok: false, message: 'verify_failed' } });
      expect(JSON.stringify(failed)).not.toContain('pw');
    });
  });
});
