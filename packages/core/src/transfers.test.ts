import { describe, expect, it } from 'vitest';
import {
  type TransferCandidate,
  findTransferPairs,
  isPlatformTransferLeg,
  namesAccount,
  referencesOtherAccount,
} from './transfers';

const c = (
  id: string,
  accountId: string,
  bookingDate: string,
  amount: number,
  currency = 'EUR',
): TransferCandidate => ({
  id,
  accountId,
  bookingDate,
  amount,
  currency,
});

describe('findTransferPairs', () => {
  it('pairs an outflow with the matching inflow as [out, in]', () => {
    const r = findTransferPairs([
      c('in1', 'b', '2025-01-02', 5000),
      c('out1', 'a', '2025-01-01', -5000),
    ]);
    expect(r).toEqual({ pairs: [['out1', 'in1']], ambiguous: [] });
  });

  it('rejects legs on the same account', () => {
    const r = findTransferPairs([
      c('o', 'a', '2025-01-01', -5000),
      c('i', 'a', '2025-01-01', 5000),
    ]);
    expect(r).toEqual({ pairs: [], ambiguous: [] });
  });

  it('rejects a 6-day gap with the default window (5 days), accepts 5', () => {
    expect(
      findTransferPairs([c('o', 'a', '2025-01-01', -100), c('i', 'b', '2025-01-07', 100)]).pairs,
    ).toEqual([]);
    expect(
      findTransferPairs([c('o', 'a', '2025-01-01', -100), c('i', 'b', '2025-01-06', 100)]).pairs,
    ).toEqual([['o', 'i']]);
  });

  it('honours windowDays and counts across month boundaries', () => {
    const cands = [c('o', 'a', '2025-01-31', -100), c('i', 'b', '2025-02-02', 100)];
    expect(findTransferPairs(cands, { windowDays: 1 }).pairs).toEqual([]);
    expect(findTransferPairs(cands, { windowDays: 2 }).pairs).toEqual([['o', 'i']]);
  });

  it('accepts the inflow booked before the outflow', () => {
    expect(
      findTransferPairs([c('o', 'a', '2025-01-03', -100), c('i', 'b', '2025-01-01', 100)]).pairs,
    ).toEqual([['o', 'i']]);
  });

  it('marks one outflow with two equal inflows as all ambiguous', () => {
    const r = findTransferPairs([
      c('o', 'a', '2025-01-01', -100),
      c('i1', 'b', '2025-01-01', 100),
      c('i2', 'c', '2025-01-02', 100),
    ]);
    expect(r.pairs).toEqual([]);
    expect(r.ambiguous).toEqual(['i1', 'i2', 'o']);
  });

  it('rejects currency mismatches', () => {
    expect(
      findTransferPairs([
        c('o', 'a', '2025-01-01', -100, 'EUR'),
        c('i', 'b', '2025-01-01', 100, 'USD'),
      ]),
    ).toEqual({ pairs: [], ambiguous: [] });
  });

  it('does not pair different amounts or zero amounts', () => {
    expect(
      findTransferPairs([c('o', 'a', '2025-01-01', -100), c('i', 'b', '2025-01-01', 101)]).pairs,
    ).toEqual([]);
    expect(findTransferPairs([c('o', 'a', '2025-01-01', 0), c('i', 'b', '2025-01-01', 0)])).toEqual(
      { pairs: [], ambiguous: [] },
    );
  });

  it('pairs unambiguous legs while leaving ambiguous ones aside', () => {
    const r = findTransferPairs([
      c('o1', 'a', '2025-01-01', -100),
      c('i1', 'b', '2025-01-01', 100),
      c('o2', 'a', '2025-01-10', -777),
      c('i2', 'b', '2025-01-10', 777),
      c('i3', 'c', '2025-01-10', 777),
    ]);
    expect(r.pairs).toEqual([['o1', 'i1']]);
    expect(r.ambiguous).toEqual(['i2', 'i3', 'o2']);
  });

  it('is deterministic regardless of input order', () => {
    const cands = [
      c('o2', 'a', '2025-01-02', -5),
      c('i2', 'b', '2025-01-02', 5),
      c('o1', 'a', '2025-01-01', -9),
      c('i1', 'b', '2025-01-01', 9),
    ];
    const forward = findTransferPairs(cands);
    expect(findTransferPairs([...cands].reverse())).toEqual(forward);
    expect(forward.pairs).toEqual([
      ['o1', 'i1'],
      ['o2', 'i2'],
    ]);
  });
});

describe('referencesOtherAccount', () => {
  const t212 = { name: 'Conta T212', institutionName: 'Trading 212' };
  it('matches the other account name or institution as whole words, ignoring case and accents', () => {
    expect(referencesOtherAccount('To Trading 212', t212)).toBe(true);
    expect(referencesOtherAccount('PAGAMENTO CONTA T212 12/05', t212)).toBe(true);
    expect(referencesOtherAccount('trading-212 deposit', t212)).toBe(true);
    expect(referencesOtherAccount('Trading 2120', t212)).toBe(false);
  });

  it('matches the generic own-transfer markers', () => {
    for (const text of [
      'Transfer to savings',
      'Transferência para poupança',
      'Top-up',
      'TOPUP 5',
      'Carregamento cartao',
    ]) {
      expect(referencesOtherAccount(text, { name: 'Savings' })).toBe(true);
    }
  });

  it('does not match ordinary purchases or payments from people', () => {
    expect(referencesOtherAccount('Restaurante O Tacho', t212)).toBe(false);
    expect(referencesOtherAccount('MB WAY Joao Silva', t212)).toBe(false);
  });

  it('ignores account labels shorter than three characters', () => {
    expect(referencesOtherAccount('To me', { name: 'me', institutionName: null })).toBe(false);
  });
});

describe('referencesOtherAccount spelling variants', () => {
  const t212 = { name: 'Broker', institutionName: 'Trading 212' };
  it('ignores spaces inside names on both sides, still on whole tokens', () => {
    expect(referencesOtherAccount('To Trading212', t212)).toBe(true);
    expect(referencesOtherAccount('TRADING212 LTD', t212)).toBe(true);
    expect(referencesOtherAccount('To Trading 2120', t212)).toBe(false);
    expect(referencesOtherAccount('Xtrading212', t212)).toBe(false);
  });

  it('matches the first significant word when the name carries a legal suffix', () => {
    const revolut = { name: 'Main', institutionName: 'Revolut Ltd' };
    expect(referencesOtherAccount('Top up from Revolut', revolut)).toBe(true);
    expect(referencesOtherAccount('To REVOLUT', revolut)).toBe(true);
    expect(referencesOtherAccount('Revolution Cafe', revolut)).toBe(false);
    // Without a suffix to strip, a multi-word name must match as a whole.
    expect(referencesOtherAccount('Trading Post Cafe', t212)).toBe(false);
  });
});

describe('isPlatformTransferLeg', () => {
  it('is true for DEPOSIT/WITHDRAW provider types and, on an investment account, descriptions', () => {
    expect(
      isPlatformTransferLeg({
        rawDescription: 'x',
        providerType: 'DEPOSIT',
        accountType: 'checking',
      }),
    ).toBe(true);
    expect(
      isPlatformTransferLeg({
        rawDescription: 'WITHDRAW ab1',
        providerType: 'WITHDRAW',
        accountType: 'investment',
      }),
    ).toBe(true);
    expect(
      isPlatformTransferLeg({ rawDescription: 'Deposit ab1', accountType: 'investment' }),
    ).toBe(true);
  });

  it('is false for bank texts and other provider types', () => {
    expect(
      isPlatformTransferLeg({ rawDescription: 'DEPOSIT 100 cheque', accountType: 'checking' }),
    ).toBe(false);
    expect(
      isPlatformTransferLeg({
        rawDescription: 'Dividend VWCE',
        providerType: 'ORDINARY',
        accountType: 'investment',
      }),
    ).toBe(false);
  });
});

describe('namesAccount', () => {
  it('matches the account or institution name, never a generic transfer marker', () => {
    const main = { name: 'Everyday', institutionName: 'Neobank' };
    expect(namesAccount('Received from Everyday', main)).toBe(true);
    expect(namesAccount('NEOBANK top-up', main)).toBe(true);
    expect(namesAccount('Transfer in', main)).toBe(false);
    expect(referencesOtherAccount('Transfer in', main)).toBe(true);
  });
});
