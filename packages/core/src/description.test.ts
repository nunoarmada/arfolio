import { describe, expect, it } from 'vitest';
import { NOISE_PREFIXES, merchantKey, normalizeDescription } from './description';

describe('normalizeDescription', () => {
  it('strips prefix, card mask and date', () => {
    expect(normalizeDescription('COMPRA 1234 **** 5678 PINGO DOCE LISBOA 12/10')).toBe(
      'PINGO DOCE LISBOA',
    );
  });
  it('uppercases, strips accents and collapses whitespace', () => {
    expect(normalizeDescription('  café   Açúcar \t Lda ')).toBe('CAFE ACUCAR LDA');
  });
  it('removes compact card masks and long digit runs', () => {
    expect(normalizeDescription('SHOP ****1234 REF 123456789')).toBe('SHOP REF');
    expect(normalizeDescription('SHOP 1234*****5678')).toBe('SHOP');
  });
  it('removes dates with year', () => {
    expect(normalizeDescription('GYM 05-01-2025 MONTHLY')).toBe('GYM MONTHLY');
  });
  it('strips several leading prefixes, including multi-word ones', () => {
    expect(normalizeDescription('MB WAY TRF Alex Example')).toBe('ALEX EXAMPLE');
    expect(normalizeDescription('Pagamento Contactless Cartao Bakery')).toBe('BAKERY');
  });
  it('keeps prefix words that are not leading', () => {
    expect(normalizeDescription('MY DD STORE')).toBe('MY DD STORE');
  });
  it('does not strip a prefix that is only part of a word', () => {
    expect(normalizeDescription('COMPRAS ONLINE')).toBe('COMPRAS ONLINE');
  });
  it('keeps decimal quantities but still strips date-like tokens', () => {
    expect(normalizeDescription('MILK 2.5 KG')).toBe('MILK 2.5 KG');
    expect(normalizeDescription('SHOP 2025-01-05 A')).toBe('SHOP A');
    expect(normalizeDescription('SHOP 05.01.2025 B')).toBe('SHOP B');
    expect(normalizeDescription('SHOP 05/01/25 C')).toBe('SHOP C');
  });
  it('exposes the prefix list as a constant', () => {
    expect(NOISE_PREFIXES).toContain('MB WAY');
  });
});

describe('merchantKey', () => {
  it('prefers the counterparty when present', () => {
    expect(merchantKey('COMPRA 1234 SOMETHING', 'Acme Ltd')).toBe('ACME LTD');
  });
  it('falls back to the description when counterparty is empty or missing', () => {
    expect(merchantKey('COMPRA Bakery')).toBe('BAKERY');
    expect(merchantKey('COMPRA Bakery', '  ')).toBe('BAKERY');
    expect(merchantKey('COMPRA Bakery', null)).toBe('BAKERY');
  });
});
