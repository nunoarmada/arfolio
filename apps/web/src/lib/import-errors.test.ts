import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import { LOCALES } from '@/i18n/locales';
import { rowErrorKey } from './import-errors';

describe('rowErrorKey', () => {
  it('maps the reasons the services give', () => {
    expect(rowErrorKey('Row currency (USD) differs from the account currency (EUR)')).toEqual({
      key: 'currency',
      values: { row: 'USD', account: 'EUR' },
    });
    expect(rowErrorKey('Invalid date').key).toBe('date');
    expect(rowErrorKey('Cannot parse amount: "x"').key).toBe('amount');
    expect(rowErrorKey('Amount has more than 2 decimals: 1.234')).toEqual({
      key: 'decimals',
      values: { digits: '2' },
    });
    expect(rowErrorKey('Amount has more than 0 decimals: 12.5')).toEqual({
      key: 'decimals',
      values: { digits: '0' },
    });
    expect(rowErrorKey('Missing description').key).toBe('description');
    expect(rowErrorKey('Something else').key).toBe('other');
  });
});

describe('rowErrors.decimals', () => {
  it('names the currency decimals in every locale', async () => {
    for (const locale of LOCALES) {
      const messages = (await import(`../../messages/${locale}.json`)).default;
      const t = createTranslator({ locale, messages, namespace: 'import.rowErrors' });
      for (const digits of ['0', '1', '3']) {
        const { key, values } = rowErrorKey(`Amount has more than ${digits} decimals: 1.5`);
        const text = t(key as 'decimals', values);
        expect(text, `${locale} ${digits}`).not.toMatch(/[{}]/);
        if (digits !== '0') expect(text).toContain(digits);
      }
    }
  });
});
