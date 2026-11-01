import { loadEncryptionKey } from '@arfolio/core/server';
import { listMyPushDevices, vapidKeys, type ServiceCtx } from '@arfolio/services';
import { getDb } from '../lib/db';
import { getEnv } from '../lib/env';

export interface PushDeviceDto {
  id: string;
  userAgent: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
  failureCount: number;
}

export interface PushSettingsData {
  /** Null when the list could not be loaded (the this-device block still works). */
  devices: PushDeviceDto[] | null;
  /** The public key only: the private key never leaves the server. Null when it could not be read. */
  vapidPublicKey: string | null;
}

/**
 * The preferences page's push data. Each half fails on its own and logs only the error name, so a
 * broken list never hides the enable button and vice versa.
 */
export async function loadPushSettings(ctx: ServiceCtx): Promise<PushSettingsData> {
  const env = getEnv();
  const [devices, key] = await Promise.all([
    listMyPushDevices(ctx).then(
      (rows) =>
        rows.map((d): PushDeviceDto => ({
          id: d.id,
          userAgent: d.userAgent,
          createdAt: d.createdAt.toISOString(),
          lastSuccessAt: d.lastSuccessAt?.toISOString() ?? null,
          failureCount: d.failureCount,
        })),
      (error: unknown) => {
        console.error(
          `push devices failed to load: ${error instanceof Error ? error.name : 'unknown error'}`,
        );
        return null;
      },
    ),
    vapidKeys({
      db: getDb(),
      encryptionKey: loadEncryptionKey(env.ENCRYPTION_KEY),
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT,
      appUrl: env.APP_URL,
    }).then(
      (keys) => keys.publicKey,
      (error: unknown) => {
        console.error(
          `push key failed to load: ${error instanceof Error ? error.name : 'unknown error'}`,
        );
        return null;
      },
    ),
  ]);
  return { devices, vapidPublicKey: key };
}
