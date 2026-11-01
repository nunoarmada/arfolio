import { describe, expect, it } from 'vitest';
import { humaniseCode, moneyKindOf, operationCode, txTitle } from './transaction-display';

const base = { counterparty: null, rawDescription: 'COMPRA 1234 CONTINENTE MODELO' };

describe('txTitle', () => {
  it('prefers the merchant name, then the counterparty, then the raw description', () => {
    expect(
      txTitle({ ...base, counterparty: 'Continente', merchant: { name: 'Continente Modelo' } }),
    ).toBe('Continente Modelo');
    expect(txTitle({ ...base, counterparty: ' Continente ', merchant: null })).toBe('Continente');
    expect(txTitle({ ...base })).toBe('COMPRA 1234 CONTINENTE MODELO');
  });

  it('ignores a blank merchant name or counterparty', () => {
    expect(txTitle({ ...base, counterparty: '  ', merchant: { name: ' ' } })).toBe(
      base.rawDescription,
    );
  });
});

describe('moneyKindOf', () => {
  it('follows transfer, then sign', () => {
    expect(moneyKindOf({ transferGroupId: 'g', amount: -5 })).toBe('transfer');
    expect(moneyKindOf({ transferGroupId: null, amount: -5 })).toBe('expense');
    expect(moneyKindOf({ transferGroupId: null, amount: 5 })).toBe('income');
  });
});

describe('operation codes', () => {
  const label = (code: string) => `<${code}>`;

  it('names a bare provider operation code and its reference', () => {
    expect(operationCode('INTEREST_ON_FREE_CASH 01a11e3a-83a2-73b6-9158-0c2a1b2c3d4e')).toBe(
      'INTEREST_ON_FREE_CASH',
    );
    expect(operationCode('WITHDRAW 01a17292-2973-7e8a-8b5a-877afc077764')).toBe('WITHDRAW');
    expect(
      txTitle(
        { counterparty: null, rawDescription: 'DEPOSIT 01a1711d-b13d-788b-b249-af5aa4cbe72b' },
        label,
      ),
    ).toBe('<DEPOSIT>');
  });

  it('leaves ordinary bank text, and names given by the bank, alone', () => {
    expect(operationCode('COMPRA 1234 CONTINENTE MODELO')).toBeNull();
    expect(operationCode('CONTINENTE')).toBeNull();
    expect(operationCode('MB WAY 912345678')).toBeNull();
    expect(
      txTitle(
        {
          counterparty: 'Pingo Doce',
          rawDescription: 'WITHDRAW 01a17292-2973-7e8a-8b5a-877afc077764',
        },
        label,
      ),
    ).toBe('Pingo Doce');
    expect(
      txTitle({ counterparty: null, rawDescription: 'FEE 01a17292-2973-7e8a-8b5a-877afc077764' }),
    ).toBe('FEE 01a17292-2973-7e8a-8b5a-877afc077764');
  });

  it('humanises an unknown code', () => {
    expect(humaniseCode('INTEREST_ON_FREE_CASH')).toBe('Interest on free cash');
  });
});
