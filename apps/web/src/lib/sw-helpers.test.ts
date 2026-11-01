import { describe, expect, it } from 'vitest';
import {
  FALLBACK_NOTIFICATION,
  findSameOriginClient,
  parsePushPayload,
  safeNotificationUrl,
} from './sw-helpers';

const ORIGIN = 'https://arfolio.example';

const HOME = `${ORIGIN}/`;

describe('safeNotificationUrl', () => {
  it.each([
    ['a relative path', '/budget/lines/abc', `${ORIGIN}/budget/lines/abc`],
    [
      'a relative path with a fragment',
      '/budget/lines/abc#line-abc',
      `${ORIGIN}/budget/lines/abc#line-abc`,
    ],
    [
      'a relative path with a query',
      '/transactions?status=pending',
      `${ORIGIN}/transactions?status=pending`,
    ],
    ['a same-origin absolute URL', `${ORIGIN}/settings#x`, `${ORIGIN}/settings#x`],
    ['the origin alone', ORIGIN, HOME],
    ['a harmless dot-segment', '/a/../budget', `${ORIGIN}/budget`],
  ])('keeps %s', (_name, raw, expected) => {
    expect(safeNotificationUrl(raw, ORIGIN)).toBe(expected);
  });

  const rejected: [string, unknown][] = [
    ['an absolute other-origin URL', 'https://evil.example/x'],
    ['a different port', 'https://arfolio.example:8443/x'],
    ['a different scheme on the same host', 'http://arfolio.example/x'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a mixed-case javascript: URL', 'JaVaScRiPt:alert(1)'],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
    ['a protocol-relative URL', '//evil.example/x'],
    ['a backslash protocol-relative URL', '/\\evil.example/x'],
    ['a double-backslash URL', '\\\\evil.example/x'],
    ['a tab-smuggled protocol-relative URL', '/\t/evil.example/x'],
    ['a userinfo trick', 'https://arfolio.example@evil.example/x'],
    ['an empty string', ''],
    ['a non-string', 42],
    ['null', null],
    ['undefined', undefined],
  ];

  it.each(rejected)('falls back to the home page for %s', (_name, raw) => {
    expect(safeNotificationUrl(raw, ORIGIN)).toBe(HOME);
  });

  // WHATWG normalisation turns these into a pathname starting with "//", which would resolve to
  // another origin if it were resolved a second time. The result must be absolute and stay put.
  it.each([
    ['/.//evil.example/x'],
    ['/..//evil.example'],
    ['/a/..//evil.example'],
    ['/%2e//evil.example'],
    ['/%2E%2E//evil.example'],
    ['/./../..//x'],
  ])('keeps the dot-segment URL %s on this origin', (raw) => {
    const result = safeNotificationUrl(raw, ORIGIN);
    expect(new URL(result).origin).toBe(ORIGIN);
    expect(result.startsWith(`${ORIGIN}/`)).toBe(true);
  });

  it('only ever returns an absolute URL on the origin, for every input above', () => {
    const accepted = [
      '/budget',
      '/a/../b',
      `${ORIGIN}/x`,
      '/.//evil.example/x',
      '/..//evil.example',
    ];
    for (const raw of [...accepted, ...rejected.map(([, r]) => r)]) {
      expect(new URL(safeNotificationUrl(raw, ORIGIN)).origin).toBe(ORIGIN);
    }
  });

  it('falls back to the origin home when the origin itself is not a valid URL base', () => {
    expect(safeNotificationUrl('/x', 'not a url')).toBe('/');
  });
});

describe('findSameOriginClient', () => {
  const c = (url: string) => ({ url });
  it('returns the first client on the origin', () => {
    const mine = c(`${ORIGIN}/budget`);
    expect(
      findSameOriginClient([c('https://other.example/'), mine, c(`${ORIGIN}/x`)], ORIGIN),
    ).toBe(mine);
  });
  it('ignores other origins and unparseable URLs', () => {
    expect(
      findSameOriginClient([c('https://other.example/'), c('about:blank'), c('')], ORIGIN),
    ).toBe(undefined);
  });
});

describe('parsePushPayload', () => {
  it('reads title, body, tag and url from a JSON string', () => {
    const raw = JSON.stringify({ title: 'T', body: 'B', tag: 'g1', url: '/budget' });
    expect(parsePushPayload(raw)).toEqual({ title: 'T', body: 'B', tag: 'g1', url: '/budget' });
  });

  it.each([
    ['null (no payload)', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['invalid JSON', '{not json'],
    ['a JSON array', '[1,2]'],
    ['a JSON string', '"hi"'],
    ['a JSON null', 'null'],
    ['an empty object', '{}'],
    ['a payload with a blank title', JSON.stringify({ title: '   ' })],
    ['a payload with a non-string title', JSON.stringify({ title: 5 })],
  ])('gives the generic notification for %s', (_name, raw) => {
    expect(parsePushPayload(raw)).toEqual(FALLBACK_NOTIFICATION);
  });

  it('uses the generic title only when the body is given without a title', () => {
    expect(parsePushPayload(JSON.stringify({ body: 'B' }))).toEqual({
      ...FALLBACK_NOTIFICATION,
      body: 'B',
    });
  });

  it('drops a non-string body, tag and url', () => {
    const raw = JSON.stringify({ title: 'T', body: 1, tag: {}, url: ['/x'] });
    expect(parsePushPayload(raw)).toEqual({ title: 'T', body: '', tag: undefined, url: '/' });
  });

  it('defaults the url to /', () => {
    expect(parsePushPayload(JSON.stringify({ title: 'T' })).url).toBe('/');
  });
});
