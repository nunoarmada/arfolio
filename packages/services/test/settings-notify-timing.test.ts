import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listenForSettingsChanges } from '../src/index.js';

/** A pooled client that accepts LISTEN and records how it was released. */
class FakeClient extends EventEmitter {
  released: boolean | undefined;
  query = vi.fn(async () => ({}));
  release = vi.fn((destroy?: boolean) => {
    this.released = destroy;
  });
}

function fakePool(connect: () => Promise<FakeClient>) {
  const connectSpy = vi.fn(connect);
  return { pool: { connect: connectSpy } as unknown as pg.Pool, connect: connectSpy };
}

describe('settings listener timing and shutdown (fake pool)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps backing off when connections die right after LISTEN', async () => {
    const clients: FakeClient[] = [];
    const { pool, connect } = fakePool(async () => {
      const c = new FakeClient();
      clients.push(c);
      return c;
    });
    const l = listenForSettingsChanges(pool, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(1);

    // Each connection dies at once: the waits must grow 250, 500, 1000 ms, not stay at 250.
    for (const [wait, calls] of [
      [250, 2],
      [500, 3],
      [1000, 4],
    ] as const) {
      clients.at(-1)!.emit('end');
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(connect).toHaveBeenCalledTimes(calls - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(connect).toHaveBeenCalledTimes(calls);
    }
    await l.close();
  });

  it('resets the backoff once a connection has stayed up for 30 s', async () => {
    const clients: FakeClient[] = [];
    const { pool, connect } = fakePool(async () => {
      const c = new FakeClient();
      clients.push(c);
      return c;
    });
    const l = listenForSettingsChanges(pool, () => {});
    await vi.advanceTimersByTimeAsync(0);
    clients.at(-1)!.emit('end'); // wait 250
    await vi.advanceTimersByTimeAsync(250);
    clients.at(-1)!.emit('end'); // wait 500
    await vi.advanceTimersByTimeAsync(500);
    expect(connect).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(30_000); // stable
    clients.at(-1)!.emit('end');
    await vi.advanceTimersByTimeAsync(250);
    expect(connect).toHaveBeenCalledTimes(4);
    await l.close();
  });

  it('close() during a pending reconnect timer connects no more', async () => {
    const clients: FakeClient[] = [];
    const { pool, connect } = fakePool(async () => {
      const c = new FakeClient();
      clients.push(c);
      return c;
    });
    const l = listenForSettingsChanges(pool, () => {});
    await vi.advanceTimersByTimeAsync(0);
    clients[0]!.emit('end'); // schedules a reconnect
    await l.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('close() during an in-flight pool.connect() releases that connection and stops', async () => {
    const late = new FakeClient();
    let resolve!: (c: FakeClient) => void;
    const { pool, connect } = fakePool(() => new Promise((r) => (resolve = r)));
    const onChange = vi.fn();
    const l = listenForSettingsChanges(pool, onChange);
    const closing = l.close();
    resolve(late);
    await closing;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(late.release).toHaveBeenCalledWith(true);
    expect(late.query).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });
});
