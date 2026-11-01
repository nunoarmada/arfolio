import { describe, expect, it } from 'vitest';
import { sharedAccountWarning } from './saving-line-warnings';

const others = [
  { id: 'a', name: 'Reforma', kind: 'saving' as const, accountId: 'acc-1' },
  { id: 'b', name: 'Renda', kind: 'expense' as const, accountId: 'acc-1' },
  { id: 'c', name: 'Férias', kind: 'saving' as const, accountId: 'acc-2' },
];

describe('sharedAccountWarning', () => {
  it('investment account without pies: names the other saving line', () => {
    expect(sharedAccountWarning('acc-1', [], others, true)).toEqual({
      key: 'sharedPies',
      line: 'Reforma',
    });
  });
  it('non-investment account: the unassigned warning, whatever the pies', () => {
    expect(sharedAccountWarning('acc-1', [], others, false)).toEqual({
      key: 'sharedUnassigned',
      line: 'Reforma',
    });
  });
  it('is silent once an investment line has pies', () => {
    expect(sharedAccountWarning('acc-1', ['bucket-1'], others, true)).toBeNull();
  });
  it('is silent for a line with pies even when the picker is hidden (archived account)', () => {
    expect(sharedAccountWarning('acc-1', ['bucket-1'], others, false)).toBeNull();
  });
  it('ignores other kinds, other accounts and no account', () => {
    expect(sharedAccountWarning('acc-3', [], others, false)).toBeNull();
    expect(sharedAccountWarning('', [], others, true)).toBeNull();
    expect(sharedAccountWarning('acc-1', [], [others[1]!], false)).toBeNull();
  });
});
