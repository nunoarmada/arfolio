import { describe, expect, it } from 'vitest';
import { isHomeEmpty } from './home-empty';

describe('isHomeEmpty', () => {
  it('is empty only with no accounts and nothing counted in net worth', () => {
    expect(isHomeEmpty({ kind: 'ready', count: 0 }, { kind: 'ready', itemCount: 0 })).toBe(true);
  });

  it('is not empty when assets or liabilities exist without any account', () => {
    expect(isHomeEmpty({ kind: 'ready', count: 0 }, { kind: 'ready', itemCount: 2 })).toBe(false);
  });

  it('is not empty with accounts', () => {
    expect(isHomeEmpty({ kind: 'ready', count: 1 }, { kind: 'ready', itemCount: 0 })).toBe(false);
  });

  it('keeps the old rule when net worth could not be loaded, and shows the page on an accounts error', () => {
    expect(isHomeEmpty({ kind: 'ready', count: 0 }, { kind: 'error' })).toBe(true);
    expect(isHomeEmpty({ kind: 'error' }, { kind: 'ready', itemCount: 0 })).toBe(false);
  });
});
