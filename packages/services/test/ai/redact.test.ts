import { describe, expect, it } from 'vitest';
import { redactForAi } from '../../src/ai/redact.js';

describe('redactForAi', () => {
  it.each([
    ['PT50 0002 0123 1234 5678 9015 4', 'TRF # JOAO', 'TRF PT50 0002 0123 1234 5678 9015 4 JOAO'],
    ['compact IBAN', 'TRF # X', 'TRF PT50000201231234567890154 X'],
    ['lowercase IBAN', 'to # now', 'to de89 3704 0044 0532 0130 00 now'],
  ])('strips IBANs (%s)', (_name, expected, input) => {
    expect(redactForAi(input)).toBe(expected);
  });

  it('strips card numbers with spaces or dashes', () => {
    expect(redactForAi('CARD 4111 1111 1111 1111 SHOP')).toBe('CARD # SHOP');
    expect(redactForAi('CARD 4111-1111-1111-1111 SHOP')).toBe('CARD # SHOP');
    expect(redactForAi('AMEX 3782 822463 10005')).toBe('AMEX #');
    expect(redactForAi('CARD 4111111111111111')).toBe('CARD #');
  });

  it('strips any digit run of six or more', () => {
    expect(redactForAi('REF 123456 OK')).toBe('REF # OK');
    expect(redactForAi('NIF 501964843')).toBe('NIF #');
  });

  it('keeps short numbers that belong to a merchant name', () => {
    expect(redactForAi('CONTINENTE 123')).toBe('CONTINENTE 123');
    expect(redactForAi('PINGO DOCE 4521 LISBOA')).toBe('PINGO DOCE 4521 LISBOA');
    expect(redactForAi('McDonalds 12345')).toBe('McDonalds 12345');
    expect(redactForAi('COMPRA 18/10/2026 CAFE')).toBe('COMPRA 18/10/2026 CAFE');
  });

  it('strips emails', () => {
    expect(redactForAi('PAYPAL maria.silva+x@example.co.uk LTD')).toBe('PAYPAL # LTD');
  });

  it('strips phone numbers (PT and international)', () => {
    expect(redactForAi('MB WAY +351 912 345 678')).toBe('MB WAY #');
    expect(redactForAi('MB WAY 00351912345678')).toBe('MB WAY #');
    expect(redactForAi('MB WAY 912 345 678')).toBe('MB WAY #');
    expect(redactForAi('CALL +44 20 7946 0958 NOW')).toBe('CALL # NOW');
    expect(redactForAi('CALL +1 (415) 555-2671')).toBe('CALL #');
  });

  it('collapses whitespace and trims', () => {
    expect(redactForAi('  A   B \n C ')).toBe('A B C');
  });

  it('is idempotent', () => {
    const once = redactForAi('X PT50000201231234567890154 a@b.pt 912345678');
    expect(redactForAi(once)).toBe(once);
  });
});
