'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { loadEncryptionKey } from '@arfolio/core/server';
import type { InstanceSettingKey } from '@arfolio/services';
import { getDb } from '../../lib/db';
import { getBrand } from '../../lib/brand';
import { getEnv } from '../../lib/env';
import { invalidateIntegrationConfig } from '../integration-config';
import {
  removeSetting,
  runServiceTest,
  saveSetting,
  type ServiceName,
  type ServiceSettingsDeps,
  type TestOutcome,
} from '../service-settings';
import { run, type ActionResult } from './result';

function deps(): ServiceSettingsDeps {
  const env = getEnv();
  return {
    db: getDb(),
    encryptionKey: loadEncryptionKey(env.ENCRYPTION_KEY),
    env: process.env,
    appUrl: env.APP_URL,
    brandName: getBrand().name,
  };
}

/** The new value takes effect in this process at once and in the worker within its next run. */
function changed(): void {
  invalidateIntegrationConfig();
  revalidatePath('/settings/services');
}

/**
 * Owner only. Stores one instance setting, encrypted; the response never carries the value.
 * A setting an environment variable controls is refused (`set_by_environment`).
 */
export async function saveServiceSetting(input: {
  key: InstanceSettingKey;
  value: string;
}): Promise<ActionResult> {
  return run(async () => {
    await saveSetting(await headers(), input, deps());
    changed();
    return null;
  });
}

/** Owner only. Deletes the stored value so the setting falls back to its default. */
export async function removeServiceSetting(input: {
  key: InstanceSettingKey;
}): Promise<ActionResult> {
  return run(async () => {
    await removeSetting(await headers(), input, deps());
    changed();
    return null;
  });
}

/** Owner only. Tries a service with the settings in effect now (unsaved edits are not used). */
export async function testService(input: {
  service: ServiceName;
}): Promise<ActionResult<TestOutcome>> {
  return run(async () => runServiceTest(await headers(), input, deps()));
}
