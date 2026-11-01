import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@arfolio/db';
import { loadEncryptionKey } from '@arfolio/core/server';
import { deleteInstanceSetting, readInstanceSettings, writeInstanceSetting } from '../src/index.js';
import { startServicesDb, type ServicesTestDb } from './helpers.js';

const { instanceSecret } = schema;
const ENC_KEY = loadEncryptionKey('ab'.repeat(32));
const OTHER_KEY = loadEncryptionKey('cd'.repeat(32));

describe('instance settings store', () => {
  let t: ServicesTestDb;
  const rawRows = (name: string) =>
    t.owner.select().from(instanceSecret).where(eq(instanceSecret.name, name));

  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(async () => {
    await t.close();
  });

  it('round-trips a value and stores only ciphertext', async () => {
    await writeInstanceSetting(t.db, ENC_KEY, 'anthropic.apiKey', 'sk-test-123', 'user-1');

    const [row] = await rawRows('setting:anthropic.apiKey');
    expect(row?.value).toBeDefined();
    expect(row?.value).not.toContain('sk-test-123');
    expect(row?.updatedBy).toBe('user-1');

    const settings = await readInstanceSettings(t.db, ENC_KEY);
    const stored = settings['anthropic.apiKey'];
    expect(stored).toMatchObject({ value: 'sk-test-123' });
    expect(stored?.updatedAt).toBeInstanceOf(Date);
  });

  it('overwrites in place', async () => {
    await writeInstanceSetting(t.db, ENC_KEY, 'mail.from', 'a@example.com', 'user-1');
    await writeInstanceSetting(t.db, ENC_KEY, 'mail.from', 'b@example.com', 'user-1');

    expect(await rawRows('setting:mail.from')).toHaveLength(1);
    const settings = await readInstanceSettings(t.db, ENC_KEY);
    expect(settings['mail.from']).toMatchObject({ value: 'b@example.com' });
  });

  it('reports unreadable under another key', async () => {
    await writeInstanceSetting(t.db, ENC_KEY, 'smtp.url', 'smtp://u:p@h:25', 'user-1');

    const settings = await readInstanceSettings(t.db, OTHER_KEY);
    expect(settings['smtp.url']).toMatchObject({ unreadable: true });
    expect(settings['smtp.url']).not.toHaveProperty('value');
  });

  it('deletes a setting and leaves the vapid row untouched', async () => {
    await t.owner.insert(instanceSecret).values({ name: 'vapid', value: '{"x":1}' });
    await writeInstanceSetting(t.db, ENC_KEY, 'ai.reportModel', 'm', 'user-1');

    await deleteInstanceSetting(t.db, 'ai.reportModel');

    const settings = await readInstanceSettings(t.db, ENC_KEY);
    expect(settings['ai.reportModel']).toBeUndefined();
    expect(await rawRows('vapid')).toHaveLength(1);
  });
});
