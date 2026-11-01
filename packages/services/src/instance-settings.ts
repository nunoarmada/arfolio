import { eq } from 'drizzle-orm';
import { schema, type Db, type Tx } from '@arfolio/db';
import { decryptSecret, encryptSecret } from '@arfolio/core/server';

const { instanceSecret } = schema;

export type InstanceSettingKey =
  | 'anthropic.apiKey'
  | 'ai.categorisationModel'
  | 'ai.reportModel'
  | 'ai.valuationModel'
  | 'ai.valuationPortals'
  | 'enableBanking.appId'
  | 'enableBanking.privateKey'
  | 'enableBanking.apiUrl'
  | 'smtp.url'
  | 'mail.from';

/** Settings whose value is a credential: the UI never shows them back. */
export const SECRET_KEYS: ReadonlySet<InstanceSettingKey> = new Set<InstanceSettingKey>([
  'anthropic.apiKey',
  'enableBanking.privateKey',
  'smtp.url',
]);

/** A stored value, or `unreadable` when it cannot be decrypted with the current ENCRYPTION_KEY. */
export type StoredSetting = ({ value: string } | { unreadable: true }) & { updatedAt: Date };

/** The pool, or an open transaction (so a write can commit together with its audit row). */
export type SettingsExecutor = Db | Tx;

const ROW_PREFIX = 'setting:';
const rowName = (name: InstanceSettingKey): string => `${ROW_PREFIX}${name}`;
const aad = (name: InstanceSettingKey): string => `instance:setting:${name}`;

/**
 * Every stored setting, decrypted. All values are encrypted (secret or not) so the table never
 * holds plaintext config. A row that fails to decrypt (key rotated, corrupt) yields
 * `{ unreadable: true }` rather than throwing, so one bad row cannot take the instance down.
 */
export async function readInstanceSettings(
  db: Db,
  key: Buffer,
): Promise<Partial<Record<InstanceSettingKey, StoredSetting>>> {
  const rows = await db
    .select({
      name: instanceSecret.name,
      value: instanceSecret.value,
      updatedAt: instanceSecret.updatedAt,
    })
    .from(instanceSecret);
  const out: Partial<Record<InstanceSettingKey, StoredSetting>> = {};
  for (const row of rows) {
    if (!row.name.startsWith(ROW_PREFIX)) continue;
    const name = row.name.slice(ROW_PREFIX.length) as InstanceSettingKey;
    try {
      out[name] = { value: decryptSecret(row.value, key, aad(name)), updatedAt: row.updatedAt };
    } catch {
      out[name] = { unreadable: true, updatedAt: row.updatedAt };
    }
  }
  return out;
}

/** Encrypts and upserts one setting (one row per key), recording who changed it. */
export async function writeInstanceSetting(
  db: SettingsExecutor,
  key: Buffer,
  name: InstanceSettingKey,
  value: string,
  userId: string,
): Promise<void> {
  const encrypted = encryptSecret(value, key, aad(name));
  const now = new Date();
  await db
    .insert(instanceSecret)
    .values({ name: rowName(name), value: encrypted, updatedAt: now, updatedBy: userId })
    .onConflictDoUpdate({
      target: instanceSecret.name,
      set: { value: encrypted, updatedAt: now, updatedBy: userId },
    });
}

export async function deleteInstanceSetting(
  db: SettingsExecutor,
  name: InstanceSettingKey,
): Promise<void> {
  await db.delete(instanceSecret).where(eq(instanceSecret.name, rowName(name)));
}
