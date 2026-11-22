import { describe, expect, it } from 'vitest';
import type { ActionResult } from '@/server/actions/result';
import { orConnectionLost } from './import-request';

describe('orConnectionLost', () => {
  it('passes an answered result through', async () => {
    expect(await orConnectionLost(async () => ({ ok: true, data: 1 }))).toEqual({
      ok: true,
      data: 1,
    });
    const failed: ActionResult<number> = {
      ok: false,
      code: 'validation',
      reason: 'ai_busy',
      fields: [],
    };
    expect(await orConnectionLost(async () => failed)).toBe(failed);
  });

  it('turns a request that never answered into the AI timeout failure', async () => {
    expect(
      await orConnectionLost(async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).toEqual({ ok: false, code: 'validation', reason: 'ai_timeout', fields: [] });
  });
});
