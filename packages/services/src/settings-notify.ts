import type pg from 'pg';

/**
 * Postgres channel on which a trigger of `instance_secret` (migration 0050) announces every change
 * to the saved settings. A technical identifier: do not rename (see docs/architecture.md).
 */
export const SETTINGS_CHANNEL = 'arfolio_settings';

const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 30_000;

export interface SettingsListener {
  /** Stops listening, releases the connection and cancels any pending reconnect. */
  close(): Promise<void>;
}

/**
 * Holds one dedicated connection from `pool`, runs `LISTEN` on {@link SETTINGS_CHANNEL} and calls
 * `onChange` for every notification and after every (re)connect, so a change made while the
 * connection was down is never missed. When the connection errors or ends it reconnects with a
 * capped exponential backoff, until `close()`. `onError` receives messages only.
 */
export function listenForSettingsChanges(
  pool: pg.Pool,
  onChange: () => void,
  opts: { onError?(message: string): void } = {},
): SettingsListener {
  let closed = false;
  let attempt = 0;
  let timer: NodeJS.Timeout | undefined;
  let stableTimer: NodeJS.Timeout | undefined;
  let drop: (() => void) | undefined; // drops the live connection, if any
  let connecting: Promise<void> = Promise.resolve();

  const report = (message: string): void => opts.onError?.(`settings listener: ${message}`);
  const notify = (): void => {
    try {
      onChange();
    } catch (err) {
      report(err instanceof Error ? err.message : 'onChange failed');
    }
  };

  const schedule = (): void => {
    if (closed || timer) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
    attempt += 1;
    timer = setTimeout(() => {
      timer = undefined;
      connecting = connect();
    }, delay);
  };

  const connect = async (): Promise<void> => {
    if (closed) return;
    let c: pg.PoolClient;
    try {
      c = await pool.connect();
    } catch (err) {
      report(err instanceof Error ? err.message : 'connect failed');
      schedule();
      return;
    }
    let lost = false;
    const lose = (message?: string): void => {
      if (lost) return;
      lost = true;
      clearTimeout(stableTimer);
      if (message) report(message);
      if (drop === lose) drop = undefined;
      c.release(true); // destroy: a dead or half-open connection must not return to the pool
      schedule();
    };
    c.on('error', (err) => lose(err.message));
    c.on('end', () => lose());
    c.on('notification', (msg) => {
      if (msg.channel === SETTINGS_CHANNEL) notify();
    });
    if (closed) return lose();
    try {
      await c.query(`LISTEN ${SETTINGS_CHANNEL}`);
    } catch (err) {
      return lose(err instanceof Error ? err.message : 'LISTEN failed');
    }
    if (closed) return lose();
    drop = lose;
    // Only a connection that stays up resets the backoff; one that dies right after LISTEN keeps it growing.
    stableTimer = setTimeout(() => {
      attempt = 0;
    }, RETRY_MAX_MS);
    notify();
  };

  connecting = connect();

  return {
    async close() {
      closed = true;
      clearTimeout(timer);
      timer = undefined;
      await connecting;
      drop?.();
    },
  };
}
