import { describe, expect, it } from 'vitest';
import {
  buildLinks,
  linkCount,
  initialRows,
  linkableAccounts,
  validateRows,
  type LinkableAccount,
  type LinkOption,
} from './link-accounts';

const CONN = 'c1';
const opt = (patch: Partial<LinkOption> = {}): LinkOption => ({
  externalKey: 'k1',
  name: 'Conta Ordem',
  ibanLast4: '4321',
  currency: 'EUR',
  stableKey: true,
  accountId: null,
  ...patch,
});
const acc = (patch: Partial<LinkableAccount> = {}): LinkableAccount => ({
  id: 'a1',
  name: 'Ordenado',
  currency: 'EUR',
  ibanLast4: '4321',
  archived: false,
  connectionId: null,
  ...patch,
});

describe('linkableAccounts', () => {
  it('lists same-currency, active accounts that are free or already on this connection', () => {
    const list = linkableAccounts(
      opt(),
      [
        acc({ id: 'free' }),
        acc({ id: 'usd', currency: 'USD' }),
        acc({ id: 'old', archived: true }),
        acc({ id: 'other', connectionId: 'c2' }),
        acc({ id: 'mine', connectionId: CONN }),
      ],
      CONN,
    );
    expect(list.map((a) => a.id)).toEqual(['free', 'mine']);
  });
});

describe('initialRows', () => {
  it('defaults to the existing account when exactly one fits by currency and IBAN last 4', () => {
    const [row] = initialRows([opt()], [acc()], CONN, 'checking');
    expect(row).toMatchObject({ mode: 'existing', accountId: 'a1' });
  });

  it('defaults to a new account when none or several fit', () => {
    expect(initialRows([opt()], [], CONN, 'checking')[0]).toMatchObject({
      mode: 'create',
      name: 'Conta Ordem',
      type: 'checking',
    });
    expect(initialRows([opt()], [acc(), acc({ id: 'a2' })], CONN, 'checking')[0]!.mode).toBe(
      'create',
    );
    expect(initialRows([opt({ ibanLast4: undefined })], [acc()], CONN, 'checking')[0]!.mode).toBe(
      'create',
    );
  });

  it('never preselects the same account twice', () => {
    const rows = initialRows([opt(), opt({ externalKey: 'k2' })], [acc()], CONN, 'checking');
    expect(rows.map((r) => r.mode)).toEqual(['existing', 'create']);
  });

  it('keeps an already linked provider account read-only', () => {
    expect(initialRows([opt({ accountId: 'a9' })], [acc()], CONN, 'checking')[0]).toMatchObject({
      linkedTo: 'a9',
      changing: false,
      mode: 'create',
    });
  });
});

describe('validateRows and buildLinks', () => {
  const rows = () => initialRows([opt(), opt({ externalKey: 'k2' })], [], CONN, 'checking');

  it('requires a name for a new account', () => {
    const r = rows();
    r[0]!.name = '   ';
    expect(validateRows(r)).toEqual({ k1: { name: 'name' } });
  });

  it('rejects the same existing account twice, on the second row', () => {
    const r = rows();
    r[0]!.mode = 'existing';
    r[0]!.accountId = 'a1';
    r[1]!.mode = 'existing';
    r[1]!.accountId = 'a1';
    expect(validateRows(r)).toEqual({ k2: { account: 'duplicate' } });
  });

  it('counts an unchanged linked row as taking its account', () => {
    const r = initialRows(
      [opt({ accountId: 'a1' }), opt({ externalKey: 'k2' })],
      [],
      CONN,
      'checking',
    );
    r[1]!.mode = 'existing';
    r[1]!.accountId = 'a1';
    expect(validateRows(r)).toEqual({ k2: { account: 'duplicate' } });
  });

  it('builds the payload: create, existing, and nothing for ignored or unchanged rows', () => {
    const r = initialRows(
      [
        opt(),
        opt({ externalKey: 'k2' }),
        opt({ externalKey: 'k3' }),
        opt({ externalKey: 'k4', accountId: 'a7' }),
      ],
      [],
      CONN,
      'savings',
    );
    r[0]!.name = ' Poupança ';
    r[1]!.mode = 'existing';
    r[1]!.accountId = 'a2';
    r[2]!.mode = 'ignore';
    expect(buildLinks(r)).toEqual([
      { externalKey: 'k1', create: { name: 'Poupança', type: 'savings' } },
      { externalKey: 'k2', accountId: 'a2' },
    ]);
  });

  it('sends ignore for a linked row the person chose to stop syncing', () => {
    const r = initialRows(
      [opt({ externalKey: 'k1', accountId: 'a1' }), opt({ externalKey: 'k2', accountId: 'a2' })],
      [],
      CONN,
      'checking',
    );
    r[0]!.changing = true;
    r[0]!.mode = 'ignore';
    expect(validateRows(r)).toEqual({});
    expect(buildLinks(r)).toEqual([{ externalKey: 'k1', ignore: true }]);
  });

  it('counts only the accounts to link, not the ones to stop', () => {
    const r = initialRows(
      [opt({ externalKey: 'k1', accountId: 'a1' }), opt({ externalKey: 'k2' })],
      [],
      CONN,
      'checking',
    );
    r[0]!.changing = true;
    r[0]!.mode = 'ignore';
    expect(linkCount(buildLinks(r))).toBe(1);
  });
});
