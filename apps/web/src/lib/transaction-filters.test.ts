import { describe, expect, it } from 'vitest';
import {
  activeFilterCount,
  emptyFilters,
  filtersToParams,
  parseFilters,
  resolveRange,
} from './transaction-filters';

const ID = '3f2b8c1e-5d4a-4e8b-9a77-0c1d2e3f4a5b';

describe('transaction filters', () => {
  it('round-trips through the query string and keeps the URL clean by default', () => {
    expect(filtersToParams(emptyFilters()).toString()).toBe('');
    const f = {
      period: 'custom' as const,
      from: '2026-03-01',
      to: '2026-03-31',
      accountIds: [ID],
      categoryIds: [],
      review: true,
      direction: 'out' as const,
      pending: true,
      q: 'padaria',
    };
    expect(parseFilters(filtersToParams(f))).toEqual(f);
  });

  it('reads and writes the uncategorised filter (?uncategorised=1) and ignores other values', () => {
    expect(parseFilters(new URLSearchParams('uncategorised=1')).uncategorised).toBe(true);
    for (const v of ['0', 'yes', 'true', '']) {
      expect(parseFilters(new URLSearchParams(`uncategorised=${v}`)).uncategorised).toBeUndefined();
    }
    const f = { ...emptyFilters(), uncategorised: true as const };
    expect(filtersToParams(f).toString()).toBe('uncategorised=1');
    expect(parseFilters(filtersToParams(f))).toEqual(f);
    expect(filtersToParams(emptyFilters()).toString()).toBe('');
    expect(activeFilterCount(f)).toBe(1);
  });

  it('reads and writes the booked-only filter (?status=booked) and ignores other values', () => {
    expect(parseFilters(new URLSearchParams('status=booked')).booked).toBe(true);
    for (const v of ['pending', '1', 'true', '']) {
      expect(parseFilters(new URLSearchParams(`status=${v}`)).booked).toBeUndefined();
    }
    const f = { ...emptyFilters(), booked: true as const };
    expect(filtersToParams(f).toString()).toBe('status=booked');
    expect(parseFilters(filtersToParams(f))).toEqual(f);
    expect(activeFilterCount(f)).toBe(1);
  });

  it('drops booked-only when pending is also asked for, so URL, chips and list agree', () => {
    const f = parseFilters(new URLSearchParams('status=booked&pending=1'));
    expect(f.pending).toBe(true);
    expect(f.booked).toBeUndefined();
    expect(filtersToParams(f).toString()).toBe('pending=1');
  });

  it('reads and writes the no-transfers filter (?transfers=exclude) and ignores other values', () => {
    expect(parseFilters(new URLSearchParams('transfers=exclude')).excludeTransfers).toBe(true);
    for (const v of ['include', '1', 'true', '']) {
      expect(parseFilters(new URLSearchParams(`transfers=${v}`)).excludeTransfers).toBeUndefined();
    }
    const f = { ...emptyFilters(), excludeTransfers: true as const };
    expect(filtersToParams(f).toString()).toBe('transfers=exclude');
    expect(parseFilters(filtersToParams(f))).toEqual(f);
    expect(activeFilterCount(f)).toBe(1);
  });

  it('reads and writes the transfers-only filter (?transfers=only)', () => {
    const f = { ...emptyFilters(), transfersOnly: true as const };
    expect(parseFilters(new URLSearchParams('transfers=only')).transfersOnly).toBe(true);
    expect(parseFilters(new URLSearchParams('transfers=only')).excludeTransfers).toBeUndefined();
    expect(parseFilters(new URLSearchParams('transfers=exclude')).transfersOnly).toBeUndefined();
    expect(filtersToParams(f).toString()).toBe('transfers=only');
    expect(parseFilters(filtersToParams(f))).toEqual(f);
    expect(activeFilterCount(f)).toBe(1);
  });

  it('reads and writes the AI source filter and ignores other values', () => {
    expect(parseFilters(new URLSearchParams('by=ai')).by).toBe('ai');
    expect('by' in parseFilters(new URLSearchParams('by=user'))).toBe(false);
    expect(filtersToParams({ ...emptyFilters(), by: 'ai' }).toString()).toBe('by=ai');
    expect(activeFilterCount({ ...emptyFilters(), by: 'ai' })).toBe(1);
  });

  it('drops malformed input instead of failing', () => {
    const f = parseFilters(
      new URLSearchParams(
        `period=bogus&account=nope&account=${ID}&account=${ID}&category=1&review=yes&from=2026-02-30`,
      ),
    );
    expect(f).toEqual({ ...emptyFilters(), accountIds: [ID] });
    expect(parseFilters(new URLSearchParams('period=custom')).period).toBe('this-month');
  });

  it('resolves periods against today', () => {
    const today = '2026-10-18';
    expect(resolveRange(emptyFilters(), today)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(resolveRange({ ...emptyFilters(), period: 'last-month' }, today)).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(resolveRange({ ...emptyFilters(), period: 'last-90' }, today)).toEqual({
      from: '2026-07-21',
      to: today,
    });
    expect(resolveRange({ ...emptyFilters(), period: 'this-year' }, today)).toEqual({
      from: '2026-01-01',
      to: '2026-12-31',
    });
    expect(resolveRange({ ...emptyFilters(), period: 'all' }, today)).toEqual({});
  });

  it('counts active filters', () => {
    expect(activeFilterCount(emptyFilters())).toBe(0);
    expect(
      activeFilterCount({ ...emptyFilters(), period: 'all', accountIds: [ID], review: true }),
    ).toBe(3);
  });
});
