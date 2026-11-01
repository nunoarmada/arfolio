import { describe, expect, it } from 'vitest';
import { clientIp, clientKey, createRateLimiter } from './rate-limit';

describe('rate limiter', () => {
  it('allows max attempts per key per window, then recovers', () => {
    const l = createRateLimiter({ max: 3, windowMs: 1000 });
    expect([1, 2, 3, 4].map(() => l.take('a', 0))).toEqual([true, true, true, false]);
    expect(l.take('b', 0)).toBe(true);
    expect(l.take('a', 1001)).toBe(true);
  });

  it('reads the client address from the configured header', () => {
    expect(clientKey(new Headers({ 'x-real-ip': '1.2.3.4' }))).toBe('1.2.3.4');
    expect(clientKey(new Headers())).toBe('unknown');
    expect(clientIp(new Headers({ 'x-real-ip': '1.2.3.4' }))).toBe('1.2.3.4');
    expect(clientIp(new Headers())).toBeUndefined();
  });
});
