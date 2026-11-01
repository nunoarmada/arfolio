import { describe, expect, it } from 'vitest';
import { safeNext } from './safe-redirect';

const DOT_SEGMENTS = [
  '/.//evil.com',
  '/..//evil.com',
  '/a/..//evil.com',
  '/%2e//evil.com',
  '/%2e%2e//evil.com',
  '/./\\evil.com',
];
const MALICIOUS = [
  'https://evil.com',
  '//evil.com',
  '/\\evil.com',
  '/\t/evil.com',
  '/\n/evil.com',
  '/%09/evil.com',
  ...DOT_SEGMENTS,
];

describe('safeNext', () => {
  it('keeps same-origin paths with query and hash', () => {
    expect(safeNext('/settings/members?x=1#a')).toBe('/settings/members?x=1#a');
  });

  it.each([
    null,
    undefined,
    '',
    'https://evil.com',
    '//evil.com',
    '/\\evil.com',
    'settings',
    '/\t/evil.com',
    '/\n/evil.com',
    '/\r/evil.com',
    '/%09/evil.com',
    '/%0a/evil.com',
    '/%5cevil.com',
    ...DOT_SEGMENTS,
  ])('falls back to home for %j', (value) => {
    expect(safeNext(value)).toBe('/');
  });

  it('never leaves the app origin, whatever the input', () => {
    for (const payload of MALICIOUS) {
      const resolved = new URL(safeNext(payload), 'https://app.example');
      expect(resolved.origin, payload).toBe('https://app.example');
    }
  });
});
