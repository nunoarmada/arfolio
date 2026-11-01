import { describe, expect, it } from 'vitest';
import { formatBps, periodMonthName, rangeLabel, signedMoney } from './insights-format';
import { formatMoneyFor } from './money-privacy';

/** Spaces in pt-PT amounts are non-breaking; NFKC turns them into plain ones. */
const norm = (s: string) => s.normalize('NFKC');

describe('rangeLabel', () => {
  it('shows one year once when the months share it', () => {
    expect(rangeLabel(['2026-08-01', '2026-09-01', '2026-10-01'], 'pt-PT')).toBe('Ago.–out. 2026');
    expect(rangeLabel(['2026-08-01', '2026-09-01', '2026-10-01'], 'en')).toBe('Aug–Oct 2026');
  });
  it('shows both years across a year boundary', () => {
    const months = Array.from({ length: 12 }, (_, i) =>
      i < 2 ? `2025-${11 + i}-01` : `2026-${String(i - 1).padStart(2, '0')}-01`,
    );
    expect(rangeLabel(months, 'pt-PT')).toBe('Nov. 2025–out. 2026');
  });
});

describe('periodMonthName', () => {
  it('adds the year only outside the reference year', () => {
    expect(periodMonthName('2026-10-01', '2026-10-01', 'pt-PT')).toBe('outubro');
    expect(periodMonthName('2025-11-01', '2026-10-01', 'pt-PT')).toBe('novembro de 2025');
  });
});

describe('formatBps', () => {
  it('rounds to a whole percent and marks anything under 1% as "<1%"', () => {
    expect(formatBps(3400, 'en')).toBe('34%');
    expect(formatBps(99, 'en')).toBe('<1%');
    expect(formatBps(1, 'pt-PT')).toBe('<1%');
    expect(formatBps(100, 'en')).toBe('1%');
    expect(formatBps(0, 'en')).toBe('0%');
    expect(formatBps(10_000, 'en')).toBe('100%');
  });
});

describe('signedMoney', () => {
  it('uses U+2212 for negatives, an optional plus, and no sign on zero', () => {
    const fmt = formatMoneyFor(false);
    expect(norm(signedMoney(fmt, -30_000, 'EUR', 'pt-PT'))).toBe('−300,00 €');
    expect(norm(signedMoney(fmt, 50_000, 'EUR', 'pt-PT', { plus: true }))).toBe('+500,00 €');
    expect(norm(signedMoney(fmt, 50_000, 'EUR', 'pt-PT'))).toBe('500,00 €');
    expect(norm(signedMoney(fmt, 0, 'EUR', 'pt-PT', { plus: true }))).toBe('0,00 €');
  });

  it('keeps the sign but masks the amount in privacy mode', () => {
    const fmt = formatMoneyFor(true);
    expect(norm(signedMoney(fmt, -500, 'EUR', 'pt-PT'))).toBe('−•••• €');
    expect(norm(signedMoney(fmt, 500, 'EUR', 'pt-PT', { plus: true }))).toBe('+•••• €');
  });
});
