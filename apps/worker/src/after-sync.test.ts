import { describe, expect, it, vi } from 'vitest';
import { afterSyncAll } from './after-sync.js';

describe('afterSyncAll', () => {
  it('runs every step with the household id, even when one fails, and logs no content', async () => {
    const warn = vi.fn();
    const ok = vi.fn(async () => {});
    const failing = vi.fn(async () => {
      throw new Error('secret merchant name');
    });
    const after = afterSyncAll(
      [
        ['categorise', failing],
        ['merchants', ok],
      ],
      { warn },
    );
    await expect(after('hh_1')).resolves.toBeUndefined();
    expect(failing).toHaveBeenCalledWith('hh_1');
    expect(ok).toHaveBeenCalledWith('hh_1');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe('after-sync step categorise failed: Error');
  });

  it('does nothing noisy when every step succeeds', async () => {
    const warn = vi.fn();
    await afterSyncAll([['a', async () => {}]], { warn })('hh_1');
    expect(warn).not.toHaveBeenCalled();
  });
});
