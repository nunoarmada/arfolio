import { describe, expect, it } from 'vitest';
import { generateVAPIDKeys, sendNotification } from 'web-push';

// No mock here: the other push tests replace `web-push`, so a major upgrade could change its
// exports without any of them noticing.
describe('web-push module', () => {
  it('generates VAPID keys and exposes sendNotification', () => {
    const keys = generateVAPIDKeys();
    expect(keys.publicKey).toEqual(expect.any(String));
    expect(keys.publicKey.length).toBeGreaterThan(0);
    expect(keys.privateKey).toEqual(expect.any(String));
    expect(keys.privateKey.length).toBeGreaterThan(0);
    expect(typeof sendNotification).toBe('function');
  });
});
