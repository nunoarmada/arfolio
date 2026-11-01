import { describe, expect, it } from 'vitest';
import { buildAccountLinks, defaultSelection, type LinkRow } from './budget-import-links';

const row = (over: Partial<LinkRow> = {}): LinkRow => ({
  linkKey: 'asset:trading 212',
  suggestedAccountId: null,
  currentAccountId: null,
  match: null,
  ...over,
});

describe('defaultSelection', () => {
  it('preselects the suggestion for a new row', () => {
    expect(defaultSelection(row({ suggestedAccountId: 'a1' }))).toBe('a1');
    expect(defaultSelection(row())).toBe('');
  });

  it('keeps what an existing record has: its link, or none, whatever is suggested', () => {
    expect(
      defaultSelection(row({ match: 'x', currentAccountId: 'a2', suggestedAccountId: 'a1' })),
    ).toBe('a2');
    expect(defaultSelection(row({ match: 'x', suggestedAccountId: 'a1' }))).toBe('');
  });
});

describe('buildAccountLinks', () => {
  it('sends nothing while the person changes nothing', () => {
    const rows = [row({ suggestedAccountId: 'a1' }), row({ linkKey: 'asset:casa', match: 'x' })];
    expect(buildAccountLinks(rows, {})).toEqual({});
    expect(buildAccountLinks(rows, { 'asset:trading 212': 'a1', 'asset:casa': '' })).toEqual({});
  });

  it('sends null when a new row with a suggestion is unlinked', () => {
    expect(
      buildAccountLinks([row({ suggestedAccountId: 'a1' })], { 'asset:trading 212': '' }),
    ).toEqual({ 'asset:trading 212': null });
  });

  it('sends the account when a row with no suggestion is linked by hand', () => {
    expect(buildAccountLinks([row()], { 'asset:trading 212': 'a9' })).toEqual({
      'asset:trading 212': 'a9',
    });
  });

  it('never applies a suggestion to an existing record unless the person picks it', () => {
    const rows = [
      row({ linkKey: 'asset:casa', match: 'x', suggestedAccountId: 'a1' }),
      row({ linkKey: 'asset:carro', match: 'y', currentAccountId: 'a2' }),
    ];
    expect(buildAccountLinks(rows, {})).toEqual({});
    expect(buildAccountLinks(rows, { 'asset:casa': 'a1', 'asset:carro': '' })).toEqual({
      'asset:casa': 'a1',
      'asset:carro': null,
    });
  });

  it('keeps assets and liabilities of the same name apart', () => {
    const rows = [row({ linkKey: 'asset:casa' }), row({ linkKey: 'liability:casa' })];
    expect(buildAccountLinks(rows, { 'liability:casa': 'a3' })).toEqual({ 'liability:casa': 'a3' });
  });
});
