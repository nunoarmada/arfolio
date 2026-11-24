import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEncryptionKey } from '@arfolio/core/server';
import {
  SETTINGS_CHANNEL,
  deleteInstanceSetting,
  listenForSettingsChanges,
  writeInstanceSetting,
} from '../src/index.js';
import { startServicesDb, type ServicesTestDb } from './helpers.js';

const KEY = loadEncryptionKey('ab'.repeat(32));

describe('settings change notifications', () => {
  let t: ServicesTestDb;
  const pools: pg.Pool[] = [];
  const listeners: { close(): Promise<void> }[] = [];

  /** A second, independent pool on the same database (another "process"). */
  const newPool = (): pg.Pool => {
    const pool = new pg.Pool({ ...t.db.$client.options, max: 3 });
    pools.push(pool);
    return pool;
  };
  const listen = (onChange: () => void, onError?: (m: string) => void) => {
    const l = listenForSettingsChanges(newPool(), onChange, { onError });
    listeners.push(l);
    return l;
  };
  /** Waits until the initial (re)connect call has happened, then clears the counter. */
  const ready = async (onChange: ReturnType<typeof vi.fn>) => {
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    onChange.mockClear();
  };
  const listenerPids = async (): Promise<number[]> => {
    const { rows } = await t.owner.execute<{ pid: number }>(
      sql`select pid from pg_stat_activity where datname = current_database() and query = ${`LISTEN ${SETTINGS_CHANNEL}`}`,
    );
    return rows.map((r) => r.pid);
  };

  beforeAll(async () => {
    t = await startServicesDb();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.owner.execute(sql`delete from instance_secret`);
  });
  afterEach(async () => {
    await Promise.all(listeners.splice(0).map((l) => l.close()));
    await Promise.all(pools.splice(0).map((p) => p.end()));
  });

  it('notifies a listener on another pool when a setting is written and removed', async () => {
    const onChange = vi.fn();
    listen(onChange);
    await ready(onChange);

    await writeInstanceSetting(t.db, KEY, 'anthropic.apiKey', 'k', 'user-1');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    onChange.mockClear();

    await deleteInstanceSetting(t.db, 'anthropic.apiKey');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  });

  it('notifies on direct SQL run as the app role', async () => {
    await writeInstanceSetting(t.db, KEY, 'ai.reportModel', 'm1', 'user-1');
    const onChange = vi.fn();
    listen(onChange);
    await ready(onChange);

    await t.db.execute(sql`update instance_secret set updated_by = 'e2e'`);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  });

  it('keeps the trigger function off-limits to PUBLIC (the app role only fires it)', async () => {
    const { rows } = await t.owner.execute<{ pub: boolean; app: boolean }>(
      sql`select has_function_privilege('public', 'notify_settings_changed()', 'execute') as pub,
                 has_function_privilege('pfm_app', 'notify_settings_changed()', 'execute') as app`,
    );
    expect(rows).toEqual([{ pub: false, app: false }]);
  });

  it('does not notify for a change that is rolled back', async () => {
    const onChange = vi.fn();
    listen(onChange);
    await ready(onChange);

    await expect(
      t.db.transaction(async (tx) => {
        await writeInstanceSetting(tx, KEY, 'anthropic.apiKey', 'k', 'user-1');
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    // A later committed change proves notifications flow and that the rolled back one never came.
    await writeInstanceSetting(t.db, KEY, 'ai.reportModel', 'm', 'user-1');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 200));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('reconnects and calls onChange after its backend is terminated', async () => {
    const onChange = vi.fn();
    listen(onChange);
    await ready(onChange);
    const [pid] = await listenerPids();
    expect(pid).toBeDefined();

    await t.owner.execute(sql`select pg_terminate_backend(${pid})`);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), { timeout: 5000 });
    onChange.mockClear();

    // The new connection is listening.
    await writeInstanceSetting(t.db, KEY, 'ai.reportModel', 'm', 'user-1');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  });

  it('close() stops the listener and no reconnect happens afterwards', async () => {
    const onChange = vi.fn();
    const l = listen(onChange);
    await ready(onChange);

    await l.close();
    await vi.waitFor(async () => expect(await listenerPids()).toEqual([]));
    await writeInstanceSetting(t.db, KEY, 'ai.reportModel', 'm', 'user-1');
    await new Promise((r) => setTimeout(r, 800));
    expect(onChange).not.toHaveBeenCalled();
    expect(await listenerPids()).toEqual([]);
  });
});
