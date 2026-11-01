import { describe, expect, it } from 'vitest';
import { assignOccurrences, dedupeHash, dedupeKey } from './dedupe';

const base = {
  accountId: 'acc1',
  bookingDate: '2025-01-05',
  amount: -150,
  description: 'COMPRA Coffee Shop 12/10',
  occurrence: 0,
};

describe('dedupeHash', () => {
  it('is a sha256 hex digest and stable for the same input', () => {
    const h = dedupeHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(dedupeHash({ ...base })).toBe(h);
  });
  it('ignores description noise through normalisation', () => {
    expect(dedupeHash({ ...base, description: 'coffee  shop' })).toBe(dedupeHash(base));
  });
  it.each([
    ['accountId', { accountId: 'acc2' }],
    ['bookingDate', { bookingDate: '2025-01-06' }],
    ['amount', { amount: -151 }],
    ['description', { description: 'Other Shop' }],
    ['occurrence', { occurrence: 1 }],
  ])('changes when %s changes', (_n, patch) => {
    expect(dedupeHash({ ...base, ...patch })).not.toBe(dedupeHash(base));
  });
  it('does not collide when field boundaries shift', () => {
    expect(dedupeHash({ ...base, accountId: 'a', description: 'bc' })).not.toBe(
      dedupeHash({ ...base, accountId: 'ab', description: 'c' }),
    );
  });
});

describe('dedupeKey', () => {
  it('is identical for rows differing only by description noise', () => {
    expect(dedupeKey({ ...base, description: 'coffee  shop' })).toBe(dedupeKey(base));
  });
  it('differs when any identifying field differs', () => {
    expect(dedupeKey({ ...base, amount: -1 })).not.toBe(dedupeKey(base));
    expect(dedupeKey({ ...base, accountId: 'x' })).not.toBe(dedupeKey(base));
  });
  it('drives assignOccurrences so noisy duplicates get distinct hashes', () => {
    const rows = [base, { ...base, description: 'compra COFFEE shop' }];
    const out = assignOccurrences(rows, dedupeKey);
    expect(out.map((r) => r.occurrence)).toEqual([0, 1]);
    expect(dedupeHash(out[0]!)).not.toBe(dedupeHash(out[1]!));
  });
});

describe('assignOccurrences', () => {
  const row = (id: string, description: string) => ({ ...base, id, description });
  const key = dedupeKey;

  it('numbers identical rows 0, 1, ... and gives different hashes', () => {
    const out = assignOccurrences([row('a', 'Coffee'), row('b', 'coffee'), row('c', 'Tea')], key);
    expect(out.map((r) => [r.id, r.occurrence])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 0],
    ]);
    expect(dedupeHash(out[0]!)).not.toBe(dedupeHash(out[1]!));
  });
  it('does not mutate the input rows', () => {
    const rows = [{ k: 'x' }];
    const out = assignOccurrences(rows, (r) => r.k);
    expect(rows[0]).toEqual({ k: 'x' });
    expect(out[0]).toEqual({ k: 'x', occurrence: 0 });
  });
});
