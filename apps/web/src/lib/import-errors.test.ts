import { describe, expect, it } from 'vitest';
import { rowErrorKey } from './import-errors';

describe('rowErrorKey', () => {
  it('maps the reasons the services give', () => {
    expect(rowErrorKey('Row currency (USD) differs from the account currency (EUR)')).toEqual({
      key: 'currency',
      values: { row: 'USD', account: 'EUR' },
    });
    expect(rowErrorKey('Invalid date').key).toBe('date');
    expect(rowErrorKey('Cannot parse amount: "x"').key).toBe('amount');
    expect(rowErrorKey('Amount has more than 2 decimals: 1.234').key).toBe('decimals');
    expect(rowErrorKey('Missing description').key).toBe('description');
    expect(rowErrorKey('Something else').key).toBe('other');
  });
});
