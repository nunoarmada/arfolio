import { describe, expect, it } from 'vitest';
import type { ActionResult } from '@/server/actions/result';
import { orConnectionLost } from './import-request';

const dropped = async (): Promise<ActionResult<number>> => {
  throw new TypeError('Failed to fetch');
};

describe('orConnectionLost', () => {
  it('passes an answered result through', async () => {
    expect(await orConnectionLost(async () => ({ ok: true, data: 1 }), 'connection_lost')).toEqual({
      ok: true,
      data: 1,
    });
    const failed: ActionResult<number> = {
      ok: false,
      code: 'validation',
      reason: 'ai_busy',
      fields: [],
    };
    expect(await orConnectionLost(async () => failed, 'ai_timeout')).toBe(failed);
  });

  it('reports a dropped model request as the AI timeout', async () => {
    expect(await orConnectionLost(dropped, 'ai_timeout')).toEqual({
      ok: false,
      code: 'validation',
      reason: 'ai_timeout',
      fields: [],
    });
  });

  it('reports a dropped request without the model as an interrupted connection', async () => {
    expect(await orConnectionLost(dropped, 'connection_lost')).toEqual({
      ok: false,
      code: 'validation',
      reason: 'connection_lost',
      fields: [],
    });
  });
});
