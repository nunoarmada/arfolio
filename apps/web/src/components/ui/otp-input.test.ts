import { describe, expect, it } from 'vitest';
import { normalizeOtp, shouldComplete } from './otp-input';

describe('normalizeOtp', () => {
  it.each([
    ['123456', '123456'],
    ['123 456', '123456'],
    ['123-456', '123456'],
    [' 12a3b456 ', '123456'],
    ['1234567890', '123456'],
    ['', ''],
  ])('%j becomes %j', (input, expected) => {
    expect(normalizeOtp(input)).toBe(expected);
  });
});

describe('shouldComplete', () => {
  it('fires on the sixth digit only, not on extra keystrokes of a full code', () => {
    expect(shouldComplete('123456', '12345')).toBe(true);
    expect(shouldComplete(normalizeOtp('1234567'), '123456')).toBe(false);
    expect(shouldComplete('12345', '1234')).toBe(false);
  });
});
