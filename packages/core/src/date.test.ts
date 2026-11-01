import { describe, expect, it } from 'vitest';
import { DateParseError, parseDate, parseDateValue } from './date';

describe('parseDate', () => {
  it('parses DMY with slashes', () => {
    expect(parseDate('31/12/2025', 'DMY')).toBe('2025-12-31');
  });
  it('parses ISO input with auto', () => {
    expect(parseDate('2025-01-05', 'auto')).toBe('2025-01-05');
  });
  it('expands two-digit years to 20yy', () => {
    expect(parseDate('05.01.25', 'DMY')).toBe('2025-01-05');
  });
  it('parses MDY and YMD', () => {
    expect(parseDate('12/31/2025', 'MDY')).toBe('2025-12-31');
    expect(parseDate('2025.01.05', 'YMD')).toBe('2025-01-05');
  });
  it('treats auto as DMY when the year is last', () => {
    expect(parseDate('31-12-2025', 'auto')).toBe('2025-12-31');
  });
  it.each(['31/02/2025', '2025-13-01', 'nope', '1/2', '', '1/2/3/4'])(
    'throws DateParseError on %j',
    (input) => {
      expect(() => parseDate(input, 'DMY')).toThrow(DateParseError);
    },
  );
});

describe('parseDateValue', () => {
  it('converts Excel serial numbers', () => {
    expect(parseDateValue(45658, 'DMY')).toBe('2025-01-01');
  });
  it('converts Date objects using UTC components', () => {
    expect(parseDateValue(new Date(Date.UTC(2025, 5, 7)), 'DMY')).toBe('2025-06-07');
  });
  it('delegates strings to parseDate', () => {
    expect(parseDateValue('07/06/2025', 'DMY')).toBe('2025-06-07');
  });
  it('throws on invalid dates and unsupported types', () => {
    expect(() => parseDateValue(new Date('x'), 'DMY')).toThrow(DateParseError);
    expect(() => parseDateValue(null, 'DMY')).toThrow(DateParseError);
    expect(() => parseDateValue(-5, 'DMY')).toThrow(DateParseError);
  });
});
