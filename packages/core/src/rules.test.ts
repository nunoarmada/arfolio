import { describe, expect, it } from 'vitest';
import { type Rule, matchRule, validateWildcardPattern } from './rules';

const tx = {
  description: 'COMPRA Pingo Doce Lisboa',
  counterparty: null,
  amount: -2500,
  accountId: 'a1',
};
const rule = (
  id: string,
  priority: number,
  condition: Rule['condition'],
  extra: Partial<Rule> = {},
): Rule => ({
  id,
  priority,
  enabled: true,
  condition,
  categoryId: `cat-${id}`,
  ...extra,
});

describe('matchRule', () => {
  it('returns null when nothing matches or there are no rules', () => {
    expect(matchRule(tx, [])).toBeNull();
    expect(matchRule(tx, [rule('r', 1, { descriptionContains: ['netflix'] })])).toBeNull();
  });

  it('picks the lowest priority number first', () => {
    const rules = [
      rule('b', 5, { descriptionContains: ['pingo'] }),
      rule('a', 2, { descriptionContains: ['doce'] }),
    ];
    expect(matchRule(tx, rules)?.id).toBe('a');
  });

  it('breaks priority ties by id', () => {
    const rules = [rule('z', 1, {}), rule('m', 1, {}), rule('x', 1, {})];
    expect(matchRule(tx, rules)?.id).toBe('m');
  });

  it('ignores disabled rules', () => {
    const rules = [rule('a', 1, {}, { enabled: false }), rule('b', 2, {})];
    expect(matchRule(tx, rules)?.id).toBe('b');
  });

  it('matches contains case- and accent-insensitively, any-of', () => {
    expect(
      matchRule({ ...tx, description: 'Café São João' }, [
        rule('r', 1, { descriptionContains: ['nope', 'SAO joao'] }),
      ])?.id,
    ).toBe('r');
  });

  it('does not let an empty needle match everything', () => {
    expect(matchRule(tx, [rule('r', 1, { descriptionContains: ['  '] })])).toBeNull();
  });

  it('matches descriptionPattern wildcards case- and accent-insensitively', () => {
    expect(matchRule(tx, [rule('r', 1, { descriptionPattern: 'compra*LISBOA' })])?.id).toBe('r');
    expect(matchRule(tx, [rule('r', 1, { descriptionPattern: 'compra p?ngo*' })])?.id).toBe('r');
    expect(
      matchRule({ ...tx, description: 'Café' }, [rule('r', 1, { descriptionPattern: 'CAF?' })])?.id,
    ).toBe('r');
    expect(matchRule(tx, [rule('r', 1, { descriptionPattern: 'lisboa' })])).toBeNull();
    expect(matchRule(tx, [rule('r', 1, { descriptionPattern: '*lisbo' })])).toBeNull();
  });

  it('treats regex metacharacters in descriptionPattern literally', () => {
    const d = { ...tx, description: 'a.b (x) [y] a+b' };
    expect(matchRule(d, [rule('r', 1, { descriptionPattern: 'a.b (x)*' })])?.id).toBe('r');
    expect(
      matchRule({ ...d, description: 'axb (x)' }, [rule('r', 1, { descriptionPattern: 'a.b*' })]),
    ).toBeNull();
    expect(matchRule(d, [rule('r', 1, { descriptionPattern: '*[y] a+b' })])?.id).toBe('r');
    expect(matchRule(d, [rule('r', 1, { descriptionPattern: '(' })])).toBeNull();
  });

  it('skips empty or over-long patterns', () => {
    expect(matchRule(tx, [rule('e', 1, { descriptionPattern: '' })])).toBeNull();
    expect(matchRule(tx, [rule('l', 1, { descriptionPattern: '*'.repeat(201) })])).toBeNull();
  });

  it('requires all present fields to match', () => {
    const c = { descriptionContains: ['pingo'], direction: 'in' as const };
    expect(matchRule(tx, [rule('r', 1, c)])).toBeNull();
    expect(matchRule(tx, [rule('r', 1, { ...c, direction: 'out' })])?.id).toBe('r');
  });

  it('matches counterparty, and fails when it is missing', () => {
    const r = rule('r', 1, { counterpartyContains: ['acme'] });
    expect(matchRule({ ...tx, counterparty: 'ACME Ltd' }, [r])?.id).toBe('r');
    expect(matchRule({ ...tx, counterparty: null }, [r])).toBeNull();
    expect(matchRule({ ...tx, counterparty: undefined }, [r])).toBeNull();
  });

  it('applies amount ranges to signed amounts, inclusive', () => {
    const outflowAtLeast10 = rule('r', 1, { amountMax: -1000 });
    expect(matchRule({ ...tx, amount: -1000 }, [outflowAtLeast10])?.id).toBe('r');
    expect(matchRule({ ...tx, amount: -999 }, [outflowAtLeast10])).toBeNull();
    expect(matchRule({ ...tx, amount: 5000 }, [outflowAtLeast10])).toBeNull();
    const band = rule('b', 1, { amountMin: -5000, amountMax: -1000 });
    expect(matchRule({ ...tx, amount: -5001 }, [band])).toBeNull();
    expect(matchRule({ ...tx, amount: -5000 }, [band])?.id).toBe('b');
  });

  it('treats zero amounts as neither in nor out', () => {
    expect(
      matchRule({ ...tx, amount: 0 }, [
        rule('i', 1, { direction: 'in' }),
        rule('o', 2, { direction: 'out' }),
      ]),
    ).toBeNull();
  });

  it('restricts by account', () => {
    const r = rule('r', 1, { accountIds: ['a2', 'a3'] });
    expect(matchRule(tx, [r])).toBeNull();
    expect(matchRule({ ...tx, accountId: 'a3' }, [r])?.id).toBe('r');
  });

  it('does not mutate the rules array order', () => {
    const rules = [rule('b', 2, {}), rule('a', 1, {})];
    matchRule(tx, rules);
    expect(rules.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('validateWildcardPattern', () => {
  it('accepts ordinary patterns', () => {
    expect(validateWildcardPattern('compra*lisboa')).toEqual({ ok: true });
    expect(validateWildcardPattern('*')).toEqual({ ok: true });
    expect(validateWildcardPattern('a'.repeat(200))).toEqual({ ok: true });
  });
  it('rejects over-long and empty patterns', () => {
    expect(validateWildcardPattern('a'.repeat(201))).toEqual({ ok: false, reason: 'too_long' });
    expect(validateWildcardPattern('')).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('matchRule wildcard limits', () => {
  it('finishes a pathological pattern fast', () => {
    const start = performance.now();
    const d = { ...tx, description: 'a'.repeat(500) };
    expect(matchRule(d, [rule('p', 1, { descriptionPattern: '*a*a*a*a*a*b' })])).toBeNull();
    expect(performance.now() - start).toBeLessThan(200);
  });

  it('tests patterns against at most 500 characters of text', () => {
    const r = [rule('r', 1, { descriptionPattern: '*END' })];
    expect(matchRule({ ...tx, description: 'x'.repeat(600) + 'END' }, r)).toBeNull();
    expect(matchRule({ ...tx, description: 'y'.repeat(497) + 'END' }, r)?.id).toBe('r');
  });
});
