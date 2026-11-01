import { describe, expect, it, vi } from 'vitest';
import { persistPrivacy, privacyFromCookies } from './privacy-setting';

describe('privacyFromCookies', () => {
  it('finds the privacy cookie among others', () => {
    expect(privacyFromCookies('theme=dark; privacy=on; locale=pt-PT')).toBe(true);
    expect(privacyFromCookies('privacy=off')).toBe(false);
  });

  it('treats a missing or garbage cookie as visible', () => {
    expect(privacyFromCookies('')).toBe(false);
    expect(privacyFromCookies('theme=dark')).toBe(false);
    expect(privacyFromCookies('privacy=yes; xprivacy=on')).toBe(false);
  });
});

describe('persistPrivacy', () => {
  it('saves the new setting and leaves the switch as it is', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const revert = vi.fn();
    const report = vi.fn();
    await persistPrivacy(true, { save, revert, report });
    expect(save).toHaveBeenCalledWith(true);
    expect(revert).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it('puts the switch back and reports when saving fails (offline, server error)', async () => {
    const error = new Error('offline');
    const save = vi.fn().mockRejectedValue(error);
    const revert = vi.fn();
    const report = vi.fn();
    await expect(persistPrivacy(true, { save, revert, report })).resolves.toBeUndefined();
    expect(revert).toHaveBeenCalledWith(false);
    expect(report).toHaveBeenCalledWith(error);
  });
});
