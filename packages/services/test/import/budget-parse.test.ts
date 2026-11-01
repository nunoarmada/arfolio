import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_ROWS, ValidationError } from '../../src/index.js';
import { numberToMinor, parseBudgetWorkbook } from '../../src/import/budget/parse.js';
import { readBudgetWorkbook } from '../../src/import/budget/read.js';
import {
  buildBudgetSheet,
  zipBomb,
  type BudgetSheetOptions,
  type NetWorthFixtureRow,
} from '../fixtures/budget-sheet.js';

/** `today` defaults to after every month of the fixture, so no month is a projection. */
async function parse(opts?: BudgetSheetOptions, today = '2027-12-31') {
  return parseBudgetWorkbook(await readBudgetWorkbook(await buildBudgetSheet(opts)), { today });
}

const flat = (cents: number) => Array<number>(12).fill(cents);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('budget sheet: round trip of the fixture', () => {
  it('reads the config, every line with its 12 amounts, and the subscriptions', async () => {
    const sheet = await parse();
    expect(sheet.startMonth).toBe('2026-10-01');
    expect(sheet.emergencyFundMonths).toBe(6);
    expect(sheet.accounts).toEqual(['Conta Principal', 'Conta Poupança', 'Cartão A']);
    expect(sheet.groups).toEqual(['Habitação', 'Alimentação', 'Lazer']);
    expect(sheet.lines).toEqual([
      {
        kind: 'income',
        name: 'Salário A',
        group: null,
        account: 'Conta Principal',
        amounts: flat(200_000),
      },
      {
        kind: 'income',
        name: 'Salário B',
        group: null,
        account: 'Conta Principal',
        amounts: flat(150_000),
      },
      {
        kind: 'expense',
        name: 'Renda',
        group: 'Habitação',
        account: 'Conta Principal',
        amounts: flat(60_000),
      },
      {
        kind: 'expense',
        name: 'Supermercado',
        group: 'Alimentação',
        account: 'Cartão A',
        amounts: [...flat(40_000).slice(0, 11), 0],
      },
      {
        kind: 'expense',
        name: 'Cinema',
        group: 'Lazer',
        account: null,
        amounts: [5_000, 0, 5_000, 0, 5_000, 0, 5_000, 0, 5_000, 0, 5_000, 0],
      },
      { kind: 'expense', name: 'Diversos', group: null, account: 'Cartão A', amounts: flat(2_000) },
      {
        kind: 'saving',
        name: 'Fundo de emergência',
        group: null,
        account: 'Conta Poupança',
        amounts: flat(20_000),
      },
    ]);
    expect(sheet.subscriptions).toEqual([
      { name: 'Streaming A', amount: -1_200, cadence: 'monthly', account: 'Cartão A' },
      { name: 'Seguro B', amount: -24_000, cadence: 'yearly', account: 'Conta Principal' },
      { name: 'Ginásio C', amount: -9_000, cadence: 'quarterly', account: 'Cartão A' },
      { name: 'Revista D', amount: -500, cadence: 'weekly', account: null },
    ]);
    expect(sheet.subscriptionsSkipped).toBe(1);
    expect(sheet.warnings).toEqual([]);
  });

  it('computes totals from the lines (a spreadsheet example: unallocated is income - expense - saving)', async () => {
    const { lines } = await parse();
    const total = (kind: string) =>
      sum(lines.filter((l) => l.kind === kind).flatMap((l) => l.amounts));
    expect(total('income')).toBe(12 * 350_000);
    expect(total('expense')).toBe(12 * 60_000 + 11 * 40_000 + 6 * 5_000 + 12 * 2_000);
    expect(total('saving')).toBe(12 * 20_000);
  });

  it('treats empty cells like "-" as zero', async () => {
    const sheet = await parse({ blankZeros: true });
    const market = sheet.lines.find((l) => l.name === 'Supermercado')!;
    expect(market.amounts[11]).toBe(0);
    expect(sheet.warnings).toEqual([]);
  });

  it('ignores the other sheets (Painel, Património, Objetivos, Folha2)', async () => {
    const sheet = await parse();
    expect(sheet.lines.map((l) => l.name)).not.toContain('Casa');
    expect(sheet.lines.map((l) => l.name)).not.toContain('Viagem');
  });
});

describe('budget sheet: month headers', () => {
  it.each(['text', 'dotless', 'date', 'serial', 'text-date'] as const)(
    'accepts %s headers that match the config start',
    async (monthHeaders) => {
      const sheet = await parse({ monthHeaders });
      expect(sheet.warnings).toEqual([]);
      expect(sheet.lines).toHaveLength(7);
    },
  );

  it('warns month_header_mismatch for a renamed header and trusts Config B3', async () => {
    const sheet = await parse({ renameHeader: { index: 3, text: 'abril 99' } });
    expect(sheet.startMonth).toBe('2026-10-01');
    expect(sheet.warnings).toContainEqual({
      code: 'month_header_mismatch',
      params: { section: 'Receitas' },
    });
    expect(sheet.lines).toHaveLength(7);
  });

  it('warns when the headers start in another month than Config B3', async () => {
    const wb = await readBudgetWorkbook(await buildBudgetSheet());
    const moved = {
      ...wb,
      config: wb.config.map((r, i) => (i === 2 ? [r[0] ?? '', '01/01/2027'] : r)),
    };
    const sheet = parseBudgetWorkbook(moved);
    expect(sheet.startMonth).toBe('2027-01-01');
    expect(sheet.warnings.map((w) => w.code)).toContain('month_header_mismatch');
  });

  it('takes the start month from any day of Config B3', async () => {
    const sheet = await parse({ startDate: '17/10/2026' });
    expect(sheet.startMonth).toBe('2026-10-01');
    expect(sheet.warnings).toEqual([]);
  });
});

describe('budget sheet: layout surprises', () => {
  it('reads an extra line inserted above a section total', async () => {
    const sheet = await parse({ extraLineAboveTotal: true });
    expect(sheet.lines.at(-2)).toMatchObject({
      kind: 'expense',
      name: 'Extra',
      amounts: flat(1_000),
    });
    expect(sheet.lines.at(-1)).toMatchObject({ kind: 'saving', name: 'Fundo de emergência' });
    expect(sheet.warnings).toEqual([]);
  });

  it('warns total_mismatch when a section total does not include its lines', async () => {
    const sheet = await parse({
      extraLineAboveTotal: true,
      patchBudget: [{ row: 14, col: 'P', value: '1,00 €' }],
    });
    expect(sheet.warnings).toEqual([
      {
        code: 'total_mismatch',
        params: {
          section: 'Despesas',
          expected: 12 * 60_000 + 11 * 40_000 + 6 * 5_000 + 12 * 2_000 + 12 * 1_000,
          found: 100,
        },
      },
    ]);
  });

  it('warns total_mismatch for a wrong line total and still uses the computed amounts', async () => {
    const sheet = await parse({ wrongLineTotal: true });
    expect(sheet.warnings).toEqual([
      {
        code: 'total_mismatch',
        params: { section: 'Despesas', line: 'Renda', expected: 12 * 60_000, found: 100 },
      },
    ]);
    expect(sheet.lines.find((l) => l.name === 'Renda')!.amounts).toEqual(flat(60_000));
  });

  it('warns empty_section for a section without lines', async () => {
    const sheet = await parse({ emptySection: 'Poupança' });
    expect(sheet.warnings).toEqual([{ code: 'empty_section', params: { section: 'Poupança' } }]);
    expect(sheet.lines.filter((l) => l.kind === 'saving')).toEqual([]);
  });

  it('renames a repeated line name and warns duplicate_line_name', async () => {
    const sheet = await parse({ duplicateLine: true });
    const names = sheet.lines.filter((l) => l.kind === 'expense').map((l) => l.name);
    expect(names).toContain('Renda');
    expect(names).toContain('Renda (2)');
    expect(sheet.warnings).toEqual([
      { code: 'duplicate_line_name', params: { section: 'Despesas', name: 'Renda' } },
    ]);
  });

  it('skips a subscription with an unknown periodicity and warns', async () => {
    const sheet = await parse({ badPeriodicity: true });
    expect(sheet.subscriptions.map((s) => s.name)).not.toContain('Clube F');
    expect(sheet.warnings).toEqual([
      { code: 'unknown_periodicity', params: { name: 'Clube F', value: 'Bimestral' } },
    ]);
  });

  it('reads a workbook without the optional Subscrições sheet', async () => {
    const sheet = await parse({ omitSheets: ['Subscrições'] });
    expect(sheet.subscriptions).toEqual([]);
    expect(sheet.subscriptionsSkipped).toBe(0);
  });

  it('leaves the emergency fund months null when Config B4 is empty', async () => {
    expect((await parse({ emergencyMonths: null })).emergencyFundMonths).toBeNull();
  });
});

describe('budget sheet: clear failures', () => {
  it.each(['Config', 'Orçamento'])('rejects a workbook without the %s sheet', async (name) => {
    const bytes = await buildBudgetSheet({ omitSheets: [name] });
    await expect(readBudgetWorkbook(bytes)).rejects.toMatchObject({
      name: 'ValidationError',
      code: 'missing_sheet',
      params: { sheet: name },
    });
  });

  it('reports a workbook whose sheets are all hidden as no_visible_sheet', async () => {
    const wb = new ExcelJS.Workbook();
    for (const name of ['Config', 'Orçamento']) {
      const ws = wb.addWorksheet(name);
      ws.addRow(['x']);
      ws.state = 'hidden';
    }
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());
    await expect(readBudgetWorkbook(bytes)).rejects.toMatchObject({
      name: 'ValidationError',
      code: 'no_visible_sheet',
    });
  });

  it('reports a budget sheet without any section as missing_section', async () => {
    const wb = await readBudgetWorkbook(await buildBudgetSheet());
    expect(() => parseBudgetWorkbook({ ...wb, budget: [['Nada']] })).toThrow(
      expect.objectContaining({
        name: 'ValidationError',
        code: 'missing_section',
        params: { section: 'Receitas, Despesas, Poupança' },
      }),
    );
  });

  it('reports the missing subscription columns as missing_columns', async () => {
    const wb = await readBudgetWorkbook(await buildBudgetSheet());
    expect(() =>
      parseBudgetWorkbook({ ...wb, subscriptions: [[], [], ['Serviço', 'Periodicidade']] }),
    ).toThrow(
      expect.objectContaining({
        name: 'ValidationError',
        code: 'missing_columns',
        params: { sheet: 'Subscrições', columns: 'Valor' },
      }),
    );
  });

  it('names the cell of an amount that is not money', async () => {
    const bytes = await buildBudgetSheet({ patchBudget: [{ row: 9, col: 'D', value: 'abc' }] });
    const wb = await readBudgetWorkbook(bytes);
    expect(() => parseBudgetWorkbook(wb)).toThrow(/Orçamento.*D9/);
    expect(() => parseBudgetWorkbook(wb)).toThrow(
      expect.objectContaining({
        code: 'invalid_amount',
        params: { sheet: 'Orçamento', cell: 'D9', value: 'abc' },
      }),
    );
  });

  it('truncates the offending value to 40 characters and stringifies numbers', async () => {
    const long = 'x'.repeat(100);
    const wb = await readBudgetWorkbook(
      await buildBudgetSheet({ patchBudget: [{ row: 9, col: 'D', value: long }] }),
    );
    expect(() => parseBudgetWorkbook(wb)).toThrow(
      expect.objectContaining({
        code: 'invalid_amount',
        params: { sheet: 'Orçamento', cell: 'D9', value: 'x'.repeat(40) },
      }),
    );
    const huge = await readBudgetWorkbook(
      await buildBudgetSheet({ patchBudget: [{ row: 9, col: 'E', value: 1e15 }] }),
    );
    expect(() => parseBudgetWorkbook(huge)).toThrow(
      expect.objectContaining({
        code: 'invalid_amount',
        params: { sheet: 'Orçamento', cell: 'E9', value: '1000000000000000' },
      }),
    );
  });

  it('rejects negative planned amounts', async () => {
    const bytes = await buildBudgetSheet({
      patchBudget: [{ row: 9, col: 'D', value: '-5,00 €' }],
    });
    const wb = await readBudgetWorkbook(bytes);
    expect(() => parseBudgetWorkbook(wb)).toThrow(
      expect.objectContaining({
        name: 'ValidationError',
        code: 'negative_amount',
        params: { sheet: 'Orçamento', cell: 'D9' },
      }),
    );
  });

  it('rejects a line name longer than 80 characters with the name and the limit', async () => {
    const name = 'n'.repeat(81);
    const wb = await readBudgetWorkbook(
      await buildBudgetSheet({ patchBudget: [{ row: 9, col: 'A', value: name }] }),
    );
    expect(() => parseBudgetWorkbook(wb)).toThrow(
      expect.objectContaining({ code: 'name_too_long', params: { name, max: 80 } }),
    );
  });

  it('rejects an unreadable start date in Config B3', async () => {
    const wb = await readBudgetWorkbook(await buildBudgetSheet({ startDate: '31/02/2026' }));
    expect(() => parseBudgetWorkbook(wb)).toThrow(/Config.*B3/);
    expect(() => parseBudgetWorkbook(wb)).toThrow(
      expect.objectContaining({ code: 'invalid_config', params: { cell: 'B3' } }),
    );
  });

  it('rejects an invalid number of emergency months in Config B4', async () => {
    const wb = await readBudgetWorkbook(await buildBudgetSheet({ emergencyMonths: 1.5 }));
    expect(() => parseBudgetWorkbook(wb)).toThrow(
      expect.objectContaining({ code: 'invalid_config', params: { cell: 'B4' } }),
    );
  });
});

describe('budget sheet: hostile files', () => {
  it('rejects a zip bomb', async () => {
    const bomb = zipBomb(150 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    await expect(readBudgetWorkbook(bomb)).rejects.toThrow(/too large when unpacked/);
  });

  it('rejects a file that is not an archive', async () => {
    await expect(readBudgetWorkbook(Buffer.from('not a workbook'))).rejects.toMatchObject({
      name: 'ValidationError',
      code: 'unreadable_file',
    });
    await expect(readBudgetWorkbook(Buffer.alloc(0))).rejects.toMatchObject({
      code: 'unreadable_file',
    });
  });

  it('reports a zip bomb as an unreadable file as well, keeping the English message', async () => {
    await expect(readBudgetWorkbook(zipBomb(150 * 1024 * 1024))).rejects.toMatchObject({
      code: 'unreadable_file',
      message: expect.stringMatching(/too large when unpacked/) as string,
    });
  });

  it('rejects an Orçamento sheet with more than the row limit', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Config');
    const ws = wb.addWorksheet('Orçamento');
    ws.getCell(MAX_IMPORT_ROWS + 1, 1).value = 'x';
    await expect(readBudgetWorkbook(Buffer.from(await wb.xlsx.writeBuffer()))).rejects.toThrow(
      /too many rows/,
    );
  });
});

describe('budget sheet: numeric cells', () => {
  it.each([
    [1234.5, 123_450],
    [1200, 120_000],
    [-50, -5_000],
    [12.125, 1_212],
    [12.135, 1_214],
    [400 / 12, 3_333],
    [0.1 + 0.2, 30],
    [0.005, 0],
    [0.015, 2],
    [1.5e3, 150_000],
    [1e-7, 0],
  ])('converts %s to %s minor units without float arithmetic', (n, minor) => {
    expect(numberToMinor(n)).toBe(minor);
  });

  it('rejects numbers that are not amounts', () => {
    expect(() => numberToMinor(Number.NaN)).toThrow(ValidationError);
    expect(() => numberToMinor(1e15)).toThrow(ValidationError);
  });

  it('rejects an amount above 1e12 minor units with amount_too_large', () => {
    expect(numberToMinor(1e10)).toBe(1e12);
    expect(() => numberToMinor(1e10 + 0.01)).toThrowError(
      expect.objectContaining({ name: 'ValidationError', code: 'amount_too_large' }),
    );
    expect(() => numberToMinor(-5e10)).toThrowError(
      expect.objectContaining({ code: 'amount_too_large' }),
    );
  });

  it('reads a workbook whose amounts are numbers exactly like the text one', async () => {
    const text = await parse();
    const numeric = await parse({ numericAmounts: true });
    expect(numeric.lines).toEqual(text.lines);
    expect(numeric.subscriptions).toEqual(text.subscriptions);
    expect(numeric.warnings).toEqual([]);
  });

  it.each([
    [1234.5, 123_450],
    [12.125, 1_212],
    [0.1 + 0.2, 30],
    [{ formula: '400/12', result: 400 / 12 }, 3_333],
  ])('reads the number cell %j as %s', async (value, minor) => {
    const sheet = await parse({ patchBudget: [{ row: 9, col: 'D', value }] });
    expect(sheet.lines.find((l) => l.name === 'Renda')!.amounts[0]).toBe(minor);
  });

  it('rejects a negative numeric planned amount', async () => {
    await expect(parse({ patchBudget: [{ row: 9, col: 'D', value: -50 }] })).rejects.toThrow();
  });

  it('cross-checks a numeric line total', async () => {
    const sheet = await parse({ numericAmounts: true, wrongLineTotal: true });
    expect(sheet.warnings).toEqual([
      {
        code: 'total_mismatch',
        params: { section: 'Despesas', line: 'Renda', expected: 12 * 60_000, found: 100 },
      },
    ]);
  });
});

describe('budget sheet: limits and small rules', () => {
  const grid = async () => readBudgetWorkbook(await buildBudgetSheet());
  const despesas = (wb: Awaited<ReturnType<typeof grid>>) => {
    const header = wb.budget.find((r) => r[0] === 'Despesas')!;
    return header;
  };

  it('renames 500 identical names quickly and rejects the 501st line of a section', async () => {
    const wb = await grid();
    const rows = (n: number) =>
      Array.from({ length: n }, () => ['Renda', 'Habitação', 'Conta Principal']);
    const started = Date.now();
    const ok = parseBudgetWorkbook({ ...wb, budget: [despesas(wb), ...rows(500)] });
    expect(ok.lines).toHaveLength(500);
    expect(ok.lines.at(-1)!.name).toBe('Renda (500)');
    const error = await Promise.resolve()
      .then(() => parseBudgetWorkbook({ ...wb, budget: [despesas(wb), ...rows(5_000)] }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({
      code: 'too_many_rows',
      params: { section: 'Despesas', max: 500 },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('caps accounts, groups and subscriptions', async () => {
    const wb = await grid();
    const names = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => `${prefix}${i}`);
    const configWith = (col: number, n: number, prefix: string) => {
      const rows = wb.config.slice(0, 6).map((r) => [...r]);
      for (const name of names(n, prefix)) {
        const r: Array<string | number> = ['', '', ''];
        r[col] = name;
        rows.push(r);
      }
      return rows;
    };
    await expect(
      Promise.resolve().then(() => parseBudgetWorkbook({ ...wb, config: configWith(0, 201, 'A') })),
    ).rejects.toMatchObject({ code: 'too_many_rows', params: { section: 'accounts', max: 200 } });
    await expect(
      Promise.resolve().then(() => parseBudgetWorkbook({ ...wb, config: configWith(2, 201, 'G') })),
    ).rejects.toMatchObject({ code: 'too_many_rows', params: { section: 'groups', max: 200 } });
    const subs = [
      wb.subscriptions![0]!,
      wb.subscriptions![1]!,
      wb.subscriptions![2]!,
      ...names(501, 'S').map((n) => [n, '1,00', 'Mensal']),
    ];
    await expect(
      Promise.resolve().then(() => parseBudgetWorkbook({ ...wb, subscriptions: subs })),
    ).rejects.toMatchObject({
      code: 'too_many_rows',
      params: { section: 'Subscrições', max: 500 },
    });
  });

  it('keeps a renamed duplicate within the name limit', async () => {
    const long = 'x'.repeat(80);
    const wb = await grid();
    const sheet = parseBudgetWorkbook({
      ...wb,
      budget: [despesas(wb), [long], [long]],
    });
    expect(sheet.lines.map((l) => l.name)).toEqual([long, `${'x'.repeat(76)} (2)`]);
  });

  it('ends a section only at a row starting with the word Total', async () => {
    const sheet = await parse({
      patchBudget: [{ row: 9, col: 'A', value: 'Totalmente novo' }],
    });
    expect(sheet.lines.filter((l) => l.kind === 'expense').map((l) => l.name)).toEqual([
      'Totalmente novo',
      'Supermercado',
      'Cinema',
      'Diversos',
    ]);
  });

  it('counts subscriptions with no value in a warning', async () => {
    const sheet = await parse({ zeroSubscription: true });
    expect(sheet.warnings).toEqual([{ code: 'zero_value_subscription', params: { count: 1 } }]);
    expect(sheet.subscriptions.map((s) => s.name)).not.toContain('Vazio G');
  });
});

describe('budget sheet: Património', () => {
  const months = [
    '2026-10-31',
    '2026-11-30',
    '2026-12-31',
    '2027-01-31',
    '2027-02-28',
    '2027-03-31',
    '2027-04-30',
    '2027-05-31',
    '2027-06-30',
    '2027-07-31',
    '2027-08-31',
    '2027-09-30',
  ];
  const byName = <T extends { name: string }>(rows: T[] | undefined, name: string) =>
    rows!.find((r) => r.name === name)!;

  it('reads assets and credits with kinds from Tipo and a value per month at its last day', async () => {
    const { patrimonio } = await parse();
    expect(patrimonio!.assets.map((a) => [a.name, a.tipo, a.kind])).toEqual([
      ['Casa', 'Imóvel', 'real_estate'],
      ['Carro', 'Viatura', 'vehicle'],
      ['Trading Teste', 'Investimentos', 'investment'],
      ['Contas à ordem', 'Liquidez', 'cash'],
    ]);
    expect(patrimonio!.liabilities.map((a) => [a.name, a.tipo, a.kind])).toEqual([
      ['Hipoteca Casa', 'Hipoteca', 'mortgage'],
      ['Empréstimo Auto', 'Empréstimo', 'loan'],
    ]);
    const house = byName(patrimonio!.assets, 'Casa');
    expect(house.notes).toBe('Valor de mercado');
    expect(house.values).toEqual(months.map((asOf) => ({ asOf, amount: 15_000_000 })));
    expect(byName(patrimonio!.assets, 'Carro').notes).toBeNull();
    // The Total and Património líquido rows are derived and never become rows.
    expect(patrimonio!.assets.map((a) => a.name)).not.toContain('Total ativos');
    expect(patrimonio!.liabilities.map((a) => a.name)).not.toContain('Património líquido');
    expect((await parse()).warnings).toEqual([]);
  });

  it('skips blank and "-" months and keeps an explicit 0 as a zero value', async () => {
    const { patrimonio } = await parse();
    const trading = byName(patrimonio!.assets, 'Trading Teste');
    expect(trading.values.map((v) => v.asOf)).toEqual([
      '2026-10-31',
      '2026-12-31',
      '2027-01-31',
      '2027-03-31',
      '2027-04-30',
      '2027-07-31',
      '2027-08-31',
      '2027-09-30',
    ]);
    expect(trading.values.map((v) => v.amount)).toEqual([
      500_000, 520_000, 0, 540_000, 0, 560_000, 0, 580_000,
    ]);
  });

  it('ignores months that end after the import date: they are projections', async () => {
    const { patrimonio } = await parse(undefined, '2027-01-15');
    const trading = byName(patrimonio!.assets, 'Trading Teste');
    // Jan 2027 (a 0) ends on the 31st, after the 15th: not a value yet.
    expect(trading.values.map((v) => v.asOf)).toEqual(['2026-10-31', '2026-12-31']);
    expect(byName(patrimonio!.assets, 'Casa').values).toHaveLength(3);
  });

  it('counts the month ending on the import date as past', async () => {
    const { patrimonio } = await parse(undefined, '2026-10-31');
    expect(byName(patrimonio!.assets, 'Casa').values.map((v) => v.asOf)).toEqual(['2026-10-31']);
  });

  it('does not let a future "-" or 0 on a credit zero the debt', async () => {
    const { patrimonio } = await parse(undefined, '2027-06-15');
    const loan = byName(patrimonio!.liabilities, 'Empréstimo Auto');
    // Eight real months to May 2027; the 0s of June and July and the "-" after are not past yet.
    expect(loan.values.map((v) => v.asOf)).toHaveLength(8);
    expect(loan.values.at(-1)).toEqual({ asOf: '2027-05-31', amount: 100_000 });
  });

  it('refuses two month columns that resolve to the same month', async () => {
    const error = await parse({ patchNetWorth: [{ row: 3, col: 'E', value: 'out. 26' }] }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe('duplicate_month');
    expect((error as ValidationError).params).toEqual({ sheet: 'Património', month: '2026-10' });
  });

  it('keeps one cap per side across repeated header blocks', async () => {
    const wb = await readBudgetWorkbook(await buildBudgetSheet());
    const header = ['Ativos', 'Tipo', 'Notas', ...Array.from({ length: 12 }, () => '')];
    const block = (n: number, from: number) => [
      header,
      ...Array.from({ length: n }, (_, i) => [`Item ${from + i}`, 'Liquidez', '', '1,00 €']),
    ];
    const error = await Promise.resolve()
      .then(() =>
        parseBudgetWorkbook(
          { ...wb, patrimonio: [...block(101, 0), ...block(100, 101)] },
          { today: '2027-12-31' },
        ),
      )
      .catch((e: unknown) => e);
    expect((error as ValidationError).code).toBe('too_many_rows');
    expect((error as ValidationError).params).toEqual({ section: 'assets', max: 200 });
  });

  it('maps unknown Tipo values to other and warns', async () => {
    const { patrimonio, warnings } = await parse({
      extraAssets: [{ name: 'Arte', tipo: 'Coleção', months: flat(100_000) }],
      extraLiabilities: [{ name: 'Cartão X', tipo: 'Cartão', months: flat(5_000) }],
    });
    expect(byName(patrimonio!.assets, 'Arte').kind).toBe('other');
    expect(byName(patrimonio!.liabilities, 'Cartão X').kind).toBe('card');
    expect(warnings).toEqual([
      { code: 'unknown_net_worth_type', params: { name: 'Arte', value: 'Coleção' } },
    ]);
  });

  it('converts number cells exactly (12.125 is 12,12, never 12 125,00)', async () => {
    const { patrimonio } = await parse({
      patchNetWorth: [
        { row: 4, col: 'D', value: 12.125 },
        { row: 4, col: 'E', value: 0.1 + 0.2 },
        { row: 4, col: 'F', value: 1234.5 },
      ],
    });
    expect(patrimonio!.assets[0]!.values.slice(0, 3).map((v) => v.amount)).toEqual([
      1_212, 30, 123_450,
    ]);
  });

  it('reads whole workbooks written with number cells', async () => {
    const { patrimonio, goals } = await parse({ numericNetWorth: true });
    expect(byName(patrimonio!.assets, 'Casa').values[0]!.amount).toBe(15_000_000);
    expect(byName(goals!, 'Viagem').target).toBe(300_000);
  });

  it.each(['date', 'serial', 'text'] as const)(
    'maps %s month headers to the same days',
    async (monthHeaders) => {
      const { patrimonio } = await parse({ monthHeaders });
      expect(patrimonio!.assets[0]!.values.map((v) => v.asOf)).toEqual(months);
    },
  );

  it('places bare month headers in the budget year', async () => {
    const { patrimonio } = await parse({ bareNetWorthHeaders: true });
    expect(patrimonio!.assets[0]!.values.map((v) => v.asOf)).toEqual(months);
  });

  it('is null when the workbook has no such sheet, and skipping it is not an error', async () => {
    const sheet = await parse({ omitSheets: ['Património', 'Objetivos'] });
    expect(sheet.patrimonio).toBeNull();
    expect(sheet.goals).toBeNull();
    expect(sheet.warnings).toEqual([]);
  });

  it('reads a sheet without credits', async () => {
    const { patrimonio } = await parse({ noCredits: true });
    expect(patrimonio!.liabilities).toEqual([]);
    expect(patrimonio!.assets).toHaveLength(4);
  });

  it('refuses a Património sheet with no Ativos or Créditos header', async () => {
    const wb = await readBudgetWorkbook(await buildBudgetSheet());
    const error = await Promise.resolve()
      .then(() => parseBudgetWorkbook({ ...wb, patrimonio: [['Património'], ['Casa', '1']] }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe('missing_section');
  });

  it('refuses a negative value, naming the cell', async () => {
    const error = await parse({ patchNetWorth: [{ row: 5, col: 'E', value: -3 }] }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe('negative_amount');
    expect((error as ValidationError).params).toMatchObject({ sheet: 'Património', cell: 'E5' });
  });

  it('refuses text that is not an amount', async () => {
    const error = await parse({ patchNetWorth: [{ row: 4, col: 'D', value: 'muito' }] }).catch(
      (e: unknown) => e,
    );
    expect((error as ValidationError).code).toBe('invalid_amount');
  });

  it('renames a repeated name within a side and warns', async () => {
    const { patrimonio, warnings } = await parse({
      extraAssets: [{ name: 'casa', tipo: 'Imóvel', months: flat(1) }],
    });
    expect(patrimonio!.assets.map((a) => a.name)).toContain('casa (2)');
    expect(warnings).toContainEqual({
      code: 'duplicate_line_name',
      params: { section: 'Ativos', name: 'casa' },
    });
  });

  it('refuses a name longer than 120 characters', async () => {
    const error = await parse({
      extraAssets: [{ name: 'x'.repeat(121), tipo: 'Imóvel', months: flat(1) }],
    }).catch((e: unknown) => e);
    expect((error as ValidationError).code).toBe('name_too_long');
  });

  it('caps assets at 200 and credits at 200', async () => {
    const many = (n: number): NetWorthFixtureRow[] =>
      Array.from({ length: n }, (_, i) => ({ name: `Item ${i}`, tipo: 'Liquidez', months: [1] }));
    const ok = await parse({ netWorthRows: { assets: many(200), liabilities: [] } });
    expect(ok.patrimonio!.assets).toHaveLength(200);
    const assets = await parse({ netWorthRows: { assets: many(201), liabilities: [] } }).catch(
      (e: unknown) => e,
    );
    expect((assets as ValidationError).code).toBe('too_many_rows');
    expect((assets as ValidationError).params).toEqual({ section: 'assets', max: 200 });
    const credits = await parse({ netWorthRows: { assets: [], liabilities: many(201) } }).catch(
      (e: unknown) => e,
    );
    expect((credits as ValidationError).params).toEqual({ section: 'liabilities', max: 200 });
  });
});

describe('budget sheet: Objetivos', () => {
  const EMERGENCY = {
    name: 'Fundo de Emergência',
    target: 1_200_000,
    saved: 700_000,
    contribution: 20_000,
  };

  it('reads name, target, contribution and saved, and ignores the derived columns', async () => {
    const { goals, warnings } = await parse({ extraGoals: [EMERGENCY] });
    expect(goals).toEqual([
      { name: 'Férias', kind: 'generic', target: null, contribution: 10_000, saved: 0 },
      { name: 'Viagem', kind: 'generic', target: 300_000, contribution: 5_000, saved: 0 },
      {
        name: 'Fundo de Emergência',
        kind: 'emergency_fund',
        target: null,
        contribution: 20_000,
        saved: 700_000,
      },
    ]);
    // The emergency fund's own target is derived (the sheet's is ignored); its saved balance
    // is not reported because the budget has a saving line of that name.
    expect(warnings).toEqual([{ code: 'derived_target', params: { name: 'Fundo de Emergência' } }]);
  });

  it('does not read anything from Falta, Meses, Data prevista or Progresso', async () => {
    const { goals } = await parse({
      patchGoals: [
        { row: 4, col: 'E', value: 'lixo' },
        { row: 4, col: 'F', value: -5 },
        { row: 4, col: 'G', value: 'nunca' },
        { row: 4, col: 'H', value: '#REF!' },
      ],
    });
    expect(goals!.find((g) => g.name === 'Viagem')).toMatchObject({ target: 300_000 });
  });

  it.each(['Emergency fund', 'FUNDO EMERGENCIA', 'fundo de emergência'])(
    'recognises %s as the emergency fund',
    async (name) => {
      const { goals } = await parse({
        extraGoals: [{ name, target: 100, saved: 0, contribution: null }],
      });
      expect(goals!.at(-1)!.kind).toBe('emergency_fund');
    },
  );

  it('reads Saldo atual without a warning: whether it is ignored depends on the household goal', async () => {
    const { goals, warnings } = await parse({
      extraGoals: [{ name: 'Carro novo', target: 900_000, saved: 100_000, contribution: 3_000 }],
    });
    expect(goals!.at(-1)).toMatchObject({ name: 'Carro novo', saved: 100_000 });
    expect(goals!.find((g) => g.name === 'Viagem')!.saved).toBe(0);
    expect(warnings.filter((w) => w.code === 'saved_ignored')).toEqual([]);
  });

  it('treats a blank, dash or zero target and contribution as none', async () => {
    const { goals } = await parse({
      patchGoals: [
        { row: 4, col: 'B', value: '-' },
        { row: 4, col: 'D', value: 0 },
      ],
    });
    expect(goals!.find((g) => g.name === 'Viagem')).toMatchObject({
      target: null,
      contribution: null,
    });
  });

  it('refuses a sheet without the Objetivo and Meta columns', async () => {
    const wb = await readBudgetWorkbook(await buildBudgetSheet());
    const error = await Promise.resolve()
      .then(() =>
        parseBudgetWorkbook({
          ...wb,
          objetivos: [
            ['Objetivo', 'Valor'],
            ['A', '1'],
          ],
        }),
      )
      .catch((e: unknown) => e);
    expect((error as ValidationError).code).toBe('missing_columns');
  });

  it('caps goals at 100', async () => {
    const extra = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        name: `Meta ${i}`,
        target: 100,
        saved: 0,
        contribution: null,
      }));
    const ok = await parse({ extraGoals: extra(98) });
    expect(ok.goals).toHaveLength(100);
    const error = await parse({ extraGoals: extra(99) }).catch((e: unknown) => e);
    expect((error as ValidationError).params).toEqual({ section: 'goals', max: 100 });
  });
});
