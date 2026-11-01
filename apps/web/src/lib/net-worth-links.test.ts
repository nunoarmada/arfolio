import { describe, expect, it } from 'vitest';
import { linkableFor, type LinkableAccount } from './net-worth-links';

const acc = (over: Partial<LinkableAccount> & { id: string }): LinkableAccount => ({
  name: over.id,
  type: 'checking',
  includeInNetWorth: true,
  archived: false,
  balance: 0,
  ...over,
});
const ids = (list: Array<{ id: string }>) => list.map((a) => a.id);

describe('linkableFor', () => {
  const accounts = [
    acc({ id: 'checking', balance: 1_000 }),
    acc({ id: 'overdrawn', balance: -500 }),
    acc({ id: 'card', type: 'card', balance: 200 }),
    acc({ id: 'loan', type: 'loan', balance: -90_000 }),
    acc({ id: 'broker', type: 'investment', balance: 5_000 }),
    acc({ id: 'excluded', includeInNetWorth: false }),
    acc({ id: 'old', archived: true }),
  ];

  it('offers an asset the live, counted accounts that are not loans or cards', () => {
    expect(ids(linkableFor('asset', accounts, { current: null }))).toEqual([
      'checking',
      'overdrawn',
      'broker',
    ]);
  });

  it('offers a liability loans, cards and accounts that are negative now', () => {
    expect(ids(linkableFor('liability', accounts, { current: null }))).toEqual([
      'overdrawn',
      'card',
      'loan',
    ]);
  });

  it('leaves out an account another record already counts, but keeps the current link whatever it is', () => {
    const claimed = new Set(['checking', 'loan']);
    expect(ids(linkableFor('asset', accounts, { current: null, claimed }))).toEqual([
      'overdrawn',
      'broker',
    ]);
    expect(ids(linkableFor('asset', accounts, { current: 'old', claimed }))).toEqual([
      'overdrawn',
      'broker',
      'old',
    ]);
    expect(ids(linkableFor('liability', accounts, { current: 'excluded', claimed }))).toEqual([
      'overdrawn',
      'card',
      'excluded',
    ]);
  });
});
