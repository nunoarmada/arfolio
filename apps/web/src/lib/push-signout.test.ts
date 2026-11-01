import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { releasePushSubscription, SIGN_OUT_PUSH_TIMEOUT_MS } from './push-signout';

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/secret-capability-token';

function setup(overrides: Partial<Parameters<typeof releasePushSubscription>[0]> = {}) {
  const calls: string[] = [];
  const unsubscribe = vi.fn(async () => {
    calls.push('browser');
    return true;
  });
  const releaseOnServer = vi.fn(async (endpoint: string) => {
    calls.push(`server:${endpoint}`);
  });
  const deps = {
    getSubscription: async () => ({ endpoint: ENDPOINT, unsubscribe }),
    releaseOnServer,
    ...overrides,
  };
  return { deps, calls, unsubscribe, releaseOnServer };
}

describe('releasePushSubscription', () => {
  let errors: string[];
  beforeEach(() => {
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('removes the server row by endpoint first, then drops the browser subscription', async () => {
    const { deps, calls } = setup();
    await releasePushSubscription(deps);
    expect(calls).toEqual([`server:${ENDPOINT}`, 'browser']);
  });

  it('does nothing when this browser has no subscription', async () => {
    const { deps, releaseOnServer } = setup({ getSubscription: async () => null });
    await releasePushSubscription(deps);
    expect(releaseOnServer).not.toHaveBeenCalled();
  });

  it('still drops the browser subscription when the server call fails, and resolves', async () => {
    const { deps, unsubscribe } = setup({
      releaseOnServer: async () => {
        throw new TypeError(`fetch failed for ${ENDPOINT}`);
      },
    });
    await expect(releasePushSubscription(deps)).resolves.toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('resolves when the lookup rejects, logging only the error name', async () => {
    const { deps } = setup({
      getSubscription: async () => {
        throw new DOMException(`no push for ${ENDPOINT}`, 'InvalidStateError');
      },
    });
    await expect(releasePushSubscription(deps)).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('InvalidStateError');
    expect(errors[0]).not.toContain(ENDPOINT);
    expect(errors[0]).not.toContain('no push for');
  });

  it('resolves when the browser refuses to unsubscribe', async () => {
    const { deps } = setup({
      getSubscription: async () => ({
        endpoint: ENDPOINT,
        unsubscribe: async () => {
          throw new Error('boom');
        },
      }),
    });
    await expect(releasePushSubscription(deps)).resolves.toBeUndefined();
  });

  it('gives up after the time limit when a step never settles', async () => {
    vi.useFakeTimers();
    const { deps } = setup({ releaseOnServer: () => new Promise<void>(() => {}) });
    let done = false;
    const run = releasePushSubscription(deps).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(SIGN_OUT_PUSH_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(done).toBe(true);
    expect(SIGN_OUT_PUSH_TIMEOUT_MS).toBe(2000);
  });

  it('clears its timer when the work finishes first', async () => {
    vi.useFakeTimers();
    const { deps } = setup();
    await releasePushSubscription(deps);
    expect(vi.getTimerCount()).toBe(0);
  });
});
