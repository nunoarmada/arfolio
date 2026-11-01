import { describe, expect, it } from 'vitest';
import { categoryTransactionsLink, lineTransactionsLink } from './budget-links';

const range = { from: '2026-10-01', to: '2026-10-31' };
const A = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
const B = '1f1f1f1f-1f1f-4f1f-8f1f-1f1f1f1f1f1f';

describe('lineTransactionsLink', () => {
  it('lists the categories of an expense or income line within the month', () => {
    const url = lineTransactionsLink(
      { kind: 'expense', accountId: null, categoryIds: [A, B] },
      range,
    );
    const params = new URL(url!, 'http://x').searchParams;
    expect(params.get('period')).toBe('custom');
    expect(params.get('from')).toBe('2026-10-01');
    expect(params.get('to')).toBe('2026-10-31');
    expect(params.getAll('category')).toEqual([A, B]);
  });

  it('uses the account for a saving line that has one', () => {
    const params = new URL(
      lineTransactionsLink({ kind: 'saving', accountId: A, categoryIds: [B] }, range)!,
      'http://x',
    ).searchParams;
    expect(params.getAll('account')).toEqual([A]);
    expect(params.getAll('category')).toEqual([]);
  });

  it('lists only the booked transfer rows of the account for a saving line, as the number counts', () => {
    const params = new URL(
      lineTransactionsLink({ kind: 'saving', accountId: A, categoryIds: [] }, range)!,
      'http://x',
    ).searchParams;
    expect(params.get('transfers')).toBe('only');
    expect(params.get('status')).toBe('booked');
  });

  it('lists booked rows only for category lines, as pending rows are not counted', () => {
    const params = new URL(
      lineTransactionsLink({ kind: 'expense', accountId: null, categoryIds: [A] }, range)!,
      'http://x',
    ).searchParams;
    expect(params.get('status')).toBe('booked');
    expect(params.get('transfers')).toBeNull();
  });

  it('falls back to the categories for a saving line without an account', () => {
    const params = new URL(
      lineTransactionsLink({ kind: 'saving', accountId: null, categoryIds: [B] }, range)!,
      'http://x',
    ).searchParams;
    expect(params.getAll('category')).toEqual([B]);
  });

  it('has no link when nothing identifies the transactions, and caps the categories at 20', () => {
    expect(
      lineTransactionsLink({ kind: 'expense', accountId: A, categoryIds: [] }, range),
    ).toBeNull();
    const many = Array.from({ length: 25 }, (_, i) => `${i}`.padStart(8, '0') + A.slice(8));
    const params = new URL(
      lineTransactionsLink({ kind: 'expense', accountId: null, categoryIds: many }, range)!,
      'http://x',
    ).searchParams;
    expect(params.getAll('category')).toHaveLength(20);
  });
});

describe('categoryTransactionsLink', () => {
  it('points at the category, or at the uncategorised rows', () => {
    expect(categoryTransactionsLink(A, range)).toContain(`category=${A}`);
    expect(categoryTransactionsLink(null, range)).toContain('uncategorised=1');
  });

  it('lists booked rows only, and outflows only for the uncategorised rows', () => {
    const cat = new URL(categoryTransactionsLink(A, range), 'http://x').searchParams;
    expect(cat.get('status')).toBe('booked');
    expect(cat.get('type')).toBeNull();
    const none = new URL(categoryTransactionsLink(null, range), 'http://x').searchParams;
    expect(none.get('status')).toBe('booked');
    expect(none.get('type')).toBe('out');
  });
});
