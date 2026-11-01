import { describe, expect, it } from 'vitest';
import {
  describeImportError,
  describeWarning,
  sectionKey,
  truncateName,
} from './budget-import-copy';

const money = (n: number) => `€${n / 100}`;
const section = (v: string | number | undefined) => `S:${v}`;

describe('truncateName', () => {
  it('keeps short names, flattens whitespace and cuts long ones with an ellipsis', () => {
    expect(truncateName('  Casa \n renda ')).toBe('Casa renda');
    expect(truncateName('x'.repeat(100))).toHaveLength(40);
    expect(truncateName('x'.repeat(100)).endsWith('…')).toBe(true);
    expect(truncateName(undefined)).toBe('');
    expect(truncateName('ação'.repeat(20), 10)).toHaveLength(10);
  });
});

describe('sectionKey', () => {
  it('recognises the sheet sections in either language', () => {
    expect(sectionKey('Receitas')).toBe('income');
    expect(sectionKey('Poupança')).toBe('saving');
    expect(sectionKey('despesas')).toBe('expense');
    expect(sectionKey('accounts')).toBe('accounts');
    expect(sectionKey('Outra coisa')).toBeNull();
  });

  it('recognises the Património and Objetivos sections and their caps', () => {
    expect(sectionKey('Ativos')).toBe('assets');
    expect(sectionKey('assets')).toBe('assets');
    expect(sectionKey('Créditos')).toBe('liabilities');
    expect(sectionKey('liabilities')).toBe('liabilities');
    expect(sectionKey('Objetivos')).toBe('goals');
    expect(sectionKey('goals')).toBe('goals');
  });
});

describe('describeWarning', () => {
  it('formats the totals of a line and of a section', () => {
    expect(
      describeWarning(
        {
          code: 'total_mismatch',
          params: { section: 'Despesas', line: 'Renda', expected: 10000, found: 9000 },
        },
        money,
        section,
      ),
    ).toEqual({
      key: 'warning.totalMismatchLine',
      values: { section: 'S:Despesas', line: 'Renda', expected: '€100', found: '€90' },
    });
    expect(
      describeWarning(
        { code: 'total_mismatch', params: { section: 'Receitas', expected: 5, found: 7 } },
        money,
        section,
      ).key,
    ).toBe('warning.totalMismatchSection');
  });

  it('covers every known code', () => {
    const keys = [
      ['month_header_mismatch', { section: 'Receitas' }, 'warning.monthHeaderMismatch'],
      [
        'unknown_periodicity',
        { name: 'Netflix', value: 'bimestral' },
        'warning.unknownPeriodicity',
      ],
      ['empty_section', { section: 'Poupança' }, 'warning.emptySection'],
      ['duplicate_line_name', { section: 'Despesas', name: 'Luz' }, 'warning.duplicateLineName'],
      ['zero_value_subscription', { count: 3 }, 'warning.zeroValueSubscription'],
      ['unknown_net_worth_type', { name: 'Casa', value: 'Palácio' }, 'warning.unknownNetWorthType'],
      ['derived_target', { name: 'Fundo de emergência' }, 'warning.derivedTarget'],
      ['saved_ignored', { name: 'Viagem', amount: 5000 }, 'warning.savedIgnored'],
      ['currency_mismatch', { name: 'Carro' }, 'warning.currencyMismatch'],
      ['goal_unlinked', { name: 'Mealheiro' }, 'warning.goalUnlinked'],
      ['saved_differs', { name: 'Viagem', sheet: 5000, app: 7000 }, 'warning.savedDiffers'],
    ] as const;
    for (const [code, params, key] of keys) {
      expect(describeWarning({ code, params }, money, section).key).toBe(key);
    }
  });

  it('words the Património and Objetivos warnings with their values', () => {
    expect(
      describeWarning(
        { code: 'unknown_net_worth_type', params: { name: 'Casa', value: 'Palácio' } },
        money,
        section,
      ).values,
    ).toEqual({ name: 'Casa', value: 'Palácio' });
    expect(
      describeWarning(
        { code: 'saved_ignored', params: { name: 'Viagem', amount: 5000 } },
        money,
        section,
      ).values,
    ).toEqual({ name: 'Viagem', amount: '€50' });
    expect(
      describeWarning({ code: 'goal_unlinked', params: { name: 'Mealheiro' } }, money, section)
        .values,
    ).toEqual({ name: 'Mealheiro' });
    expect(
      describeWarning(
        { code: 'saved_differs', params: { name: 'Viagem', sheet: 5000, app: 7000 } },
        money,
        section,
      ).values,
    ).toEqual({ name: 'Viagem', sheet: '€50', app: '€70' });
    expect(
      describeWarning({ code: 'derived_target', params: { name: 'x'.repeat(100) } }, money, section)
        .values.name,
    ).toHaveLength(40);
  });

  it('never shows an unknown code or raw values; long names are cut', () => {
    const unknown = describeWarning(
      { code: '<script>x</script>', params: { a: 1 } },
      money,
      section,
    );
    expect(unknown).toEqual({ key: 'warning.unknown', values: {} });
    const long = describeWarning(
      { code: 'duplicate_line_name', params: { section: 'Despesas', name: 'n'.repeat(500) } },
      money,
      section,
    );
    expect(String(long.values.name)).toHaveLength(40);
  });
});

describe('describeImportError', () => {
  it('maps every validation code with its parameters', () => {
    expect(
      describeImportError('too_many_rows', { section: 'Despesas', max: 500 }, section),
    ).toEqual({
      key: 'error.tooManyRows',
      values: { section: 'S:Despesas', max: 500 },
    });
    expect(describeImportError('missing_sheet', { sheet: 'Config' }, section).key).toBe(
      'error.missingSheet',
    );
    expect(
      describeImportError(
        'invalid_amount',
        { sheet: 'Orçamento', cell: 'D9', value: 'abc' },
        section,
      ).values,
    ).toEqual({ sheet: 'Orçamento', cell: 'D9', value: 'abc' });
    expect(
      describeImportError('negative_amount', { sheet: 'Orçamento', cell: 'E4' }, section).key,
    ).toBe('error.negativeAmount');
    expect(describeImportError('invalid_config', { cell: 'B3' }, section).key).toBe(
      'error.invalidConfig',
    );
    expect(
      describeImportError('name_too_long', { name: 'x'.repeat(90), max: 80 }, section).key,
    ).toBe('error.nameTooLong');
    expect(describeImportError('missing_section', { section: 'Despesas' }, section)).toEqual({
      key: 'error.missingSection',
      values: { section: 'S:Despesas' },
    });
    expect(
      describeImportError('missing_columns', { sheet: 'Subscrições', columns: 'Valor' }, section),
    ).toEqual({ key: 'error.missingColumns', values: { sheet: 'Subscrições', columns: 'Valor' } });
    expect(describeImportError('no_visible_sheet', undefined, section).key).toBe(
      'error.noVisibleSheet',
    );
    expect(describeImportError('unreadable_file', undefined, section).key).toBe(
      'error.unreadableFile',
    );
  });

  it('maps the Património and Objetivos errors', () => {
    expect(
      describeImportError('duplicate_month', { sheet: 'Património', month: '2026-10' }, section),
    ).toEqual({ key: 'error.duplicateMonth', values: { sheet: 'Património', month: '2026-10' } });
    expect(describeImportError('emergency_fund_exists', undefined, section)).toEqual({
      key: 'error.emergencyFundExists',
      values: {},
    });
    expect(describeImportError('account_already_linked', { name: 'Casa' }, section)).toEqual({
      key: 'error.accountAlreadyLinked',
      values: { name: 'Casa' },
    });
    expect(describeImportError('too_many_rows', { section: 'assets', max: 200 }, section)).toEqual({
      key: 'error.tooManyRows',
      values: { section: 'S:assets', max: 200 },
    });
  });

  it('falls back to a generic message for an unknown or missing code', () => {
    expect(describeImportError('whatever', { a: 1 }, section).key).toBe('error.unreadable');
    expect(describeImportError(undefined, undefined, section).key).toBe('error.unreadable');
  });
});
