import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { proxy } from './proxy';

const policyFor = (path: string): string | null =>
  proxy(new NextRequest(`http://localhost:3000${path}`)).headers.get('Referrer-Policy');

describe('proxy Referrer-Policy', () => {
  it.each(['/invite/abc?t=secret', '/setup?token=secret', '/setup'])(
    'sends no-referrer on %s, where the URL may carry a secret',
    (path) => {
      expect(policyFor(path)).toBe('no-referrer');
    },
  );

  it('leaves other pages on the default policy', () => {
    expect(policyFor('/sign-in')).toBeNull();
  });
});
