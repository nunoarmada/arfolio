import { deflateRawSync, crc32 } from 'node:zlib';
import ExcelJS from 'exceljs';

/**
 * Generates a budget workbook in the observed spreadsheet layout, with invented names and round
 * amounts only. Money cells are pt-PT strings ("1 200,00 €" with no-break spaces), like the real
 * sheets, never numbers.
 */
export type BudgetSheetOptions = {
  /** Config!B3, written as text. Default `01/10/2026`. */
  startDate?: string;
  /** Config!B4. `null` leaves the cell empty. Default 6. */
  emergencyMonths?: number | null;
  /** How the 12 month headers are written. Default `text` ("out. 26"). */
  monthHeaders?: 'text' | 'dotless' | 'date' | 'serial' | 'text-date';
  /** Replaces the month header at this 0-based index with this text. */
  renameHeader?: { index: number; text: string };
  /** One more expense line directly above the "Total Despesas" row (sums include it). */
  extraLineAboveTotal?: boolean;
  /** Leaves this section without any line (its Total row follows the header). */
  emptySection?: 'Receitas' | 'Despesas' | 'Poupança';
  /** Writes a wrong sheet total on the "Renda" line (the cross-check must warn). */
  wrongLineTotal?: boolean;
  /** Writes "Renda" twice. */
  duplicateLine?: boolean;
  /** Adds a subscription with a periodicity the importer does not know. */
  badPeriodicity?: boolean;
  /** Leaves zero months empty instead of "-". */
  blankZeros?: boolean;
  /** Sheets to leave out of the workbook. */
  omitSheets?: string[];
  /** Replaces the text of a cell of the Orçamento sheet (1-based row, column letter). */
  patchBudget?: Array<{
    row: number;
    col: string;
    value: string | number | { formula: string; result: number };
  }>;
  /** Writes every amount (months, totals, subscription values) as a number cell, not text. */
  numericAmounts?: boolean;
  /** Adds a subscription whose value is "-". */
  zeroSubscription?: boolean;
  /** Writes the Património month headers as bare month names ("out", "nov") without a year. */
  bareNetWorthHeaders?: boolean;
  /** Replaces a cell of the Património sheet (1-based row, column letter). Asset rows start at row 4. */
  patchNetWorth?: Array<{ row: number; col: string; value: string | number }>;
  /** Replaces a cell of the Objetivos sheet (1-based row, column letter). Goal rows start at row 3. */
  patchGoals?: Array<{ row: number; col: string; value: string | number }>;
  /** Extra asset and liability rows (months: minor units, null for a blank cell). */
  extraAssets?: NetWorthFixtureRow[];
  extraLiabilities?: NetWorthFixtureRow[];
  /** Extra goals, below the default ones. */
  extraGoals?: GoalFixtureRow[];
  /** Writes the Património and Objetivos money cells as number cells, not pt-PT text. */
  numericNetWorth?: boolean;
  /** Replaces the default Património rows (assets, then credits) entirely. */
  netWorthRows?: { assets?: NetWorthFixtureRow[]; liabilities?: NetWorthFixtureRow[] };
  /** Leaves out the credits block of the Património sheet. */
  noCredits?: boolean;
};

export type NetWorthFixtureRow = {
  name: string;
  tipo: string;
  notes?: string;
  /** Minor units; null is a blank cell, '-' the dash a sheet shows for "nothing", 0 a real zero. */
  months: Array<number | null | '-'>;
};
export type GoalFixtureRow = {
  name: string;
  /** Minor units; null leaves the cell blank. */
  target: number | null;
  saved: number;
  contribution: number | null;
};

const NBSP = ' ';

/** Minor units as a pt-PT money string: "1 200,00 €", zero as "-". */
export function money(minor: number, zero = '-'): string {
  if (minor === 0) return zero;
  const euros = Math.floor(Math.abs(minor) / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const cents = String(Math.abs(minor) % 100).padStart(2, '0');
  return `${minor < 0 ? '-' : ''}${euros},${cents}${NBSP}€`;
}

type FixtureLine = {
  name: string;
  group: string;
  account: string;
  /** Minor units for the 12 months. */
  months: number[];
};

const flat = (cents: number) => Array<number>(12).fill(cents);

export const FIXTURE_CONFIG_ACCOUNTS = ['Conta Principal', 'Conta Poupança', 'Cartão A'];
export const FIXTURE_CONFIG_GROUPS = ['Habitação', 'Alimentação', 'Lazer'];

const INCOME: FixtureLine[] = [
  { name: 'Salário A', group: '', account: 'Conta Principal', months: flat(200_000) },
  { name: 'Salário B', group: '', account: 'Conta Principal', months: flat(150_000) },
];
const EXPENSE: FixtureLine[] = [
  { name: 'Renda', group: 'Habitação', account: 'Conta Principal', months: flat(60_000) },
  {
    name: 'Supermercado',
    group: 'Alimentação',
    account: 'Cartão A',
    months: [...flat(40_000).slice(0, 11), 0],
  },
  {
    name: 'Cinema',
    group: 'Lazer',
    account: '',
    months: [5_000, 0, 5_000, 0, 5_000, 0, 5_000, 0, 5_000, 0, 5_000, 0],
  },
  { name: 'Diversos', group: '', account: 'Cartão A', months: flat(2_000) },
];
const SAVING: FixtureLine[] = [
  { name: 'Fundo de emergência', group: '', account: 'Conta Poupança', months: flat(20_000) },
];

const num = (v: number | null | '-' | undefined): number => (typeof v === 'number' ? v : 0);
const rampDown = (from: number, step: number) =>
  Array.from({ length: 12 }, (_, i) => from - i * step);

export const DEFAULT_ASSETS: NetWorthFixtureRow[] = [
  { name: 'Casa', tipo: 'Imóvel', notes: 'Valor de mercado', months: flat(15_000_000) },
  {
    name: 'Carro',
    tipo: 'Viatura',
    months: [...flat(1_200_000).slice(0, 6), ...flat(1_100_000).slice(6)],
  },
  {
    name: 'Trading Teste',
    tipo: 'Investimentos',
    months: [500_000, null, 520_000, 0, '-', 540_000, 0, null, '-', 560_000, 0, 580_000],
  },
  { name: 'Contas à ordem', tipo: 'Liquidez', months: flat(300_000) },
];
export const DEFAULT_LIABILITIES: NetWorthFixtureRow[] = [
  { name: 'Hipoteca Casa', tipo: 'Hipoteca', months: rampDown(10_000_000, 50_000) },
  {
    name: 'Empréstimo Auto',
    tipo: 'Empréstimo',
    months: [
      800_000,
      700_000,
      600_000,
      500_000,
      400_000,
      300_000,
      200_000,
      100_000,
      0,
      0,
      '-',
      '-',
    ],
  },
];
/** The emergency fund is added per test (extraGoals): it always carries a derived_target warning. */
export const DEFAULT_GOALS: GoalFixtureRow[] = [
  { name: 'Férias', target: null, saved: 0, contribution: 10_000 },
  { name: 'Viagem', target: 300_000, saved: 0, contribution: 5_000 },
];

const MONTHS_PT = [
  'jan',
  'fev',
  'mar',
  'abr',
  'mai',
  'jun',
  'jul',
  'ago',
  'set',
  'out',
  'nov',
  'dez',
];

/** Row 1 of the sheet's year: [year, monthIndex0] of the 12 months from a dd/mm/yyyy start. */
function monthsFrom(startDate: string): Array<[number, number]> {
  const [, mm, yyyy] = startDate.split('/').map(Number) as [number, number, number];
  return Array.from({ length: 12 }, (_, i) => {
    const total = yyyy * 12 + (mm - 1) + i;
    return [Math.floor(total / 12), total % 12] as [number, number];
  });
}

const excelSerial = (year: number, month0: number) =>
  (Date.UTC(year, month0, 1) - Date.UTC(1899, 11, 30)) / 86_400_000;

const COLUMN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const colIndex = (letter: string) => COLUMN_LETTERS.indexOf(letter) + 1;

export async function buildBudgetSheet(opts: BudgetSheetOptions = {}): Promise<Buffer> {
  const startDate = opts.startDate ?? '01/10/2026';
  const emergency = opts.emergencyMonths === undefined ? 6 : opts.emergencyMonths;
  const style = opts.monthHeaders ?? 'text';
  const omit = new Set(opts.omitSheets ?? []);
  const wb = new ExcelJS.Workbook();
  const sheet = (name: string) => (omit.has(name) ? undefined : wb.addWorksheet(name));

  const config = sheet('Config');
  if (config) {
    config.getCell('A1').value = 'Configuração';
    config.getCell('A3').value = 'Início do ano orçamental';
    config.getCell('B3').value = startDate;
    config.getCell('A4').value = 'Meses do fundo de emergência';
    if (emergency !== null) config.getCell('B4').value = emergency;
    config.getCell('A6').value = 'Contas';
    config.getCell('C6').value = 'Grupos de despesa';
    FIXTURE_CONFIG_ACCOUNTS.forEach((n, i) => (config.getCell(7 + i, 1).value = n));
    FIXTURE_CONFIG_GROUPS.forEach((n, i) => (config.getCell(7 + i, 3).value = n));
  }

  const panel = sheet('Painel');
  if (panel) panel.addRow(['Painel', 'não lido']);

  const budget = sheet('Orçamento');
  if (budget) {
    const months = monthsFrom(startDate);
    const headerCells = months.map(([y, m], i): ExcelJS.CellValue => {
      if (opts.renameHeader?.index === i) return opts.renameHeader.text;
      const yy = String(y % 100).padStart(2, '0');
      switch (style) {
        case 'dotless':
          return `${MONTHS_PT[m]} ${yy}`;
        case 'date':
          return new Date(Date.UTC(y, m, 1));
        case 'serial':
          return excelSerial(y, m);
        case 'text-date':
          return `01/${String(m + 1).padStart(2, '0')}/${y}`;
        default:
          return `${MONTHS_PT[m]}. ${yy}`;
      }
    });
    const dateFormat = style === 'date' ? 'mmm yy' : undefined;

    let row = 1;
    budget.getCell(row++, 1).value = 'Orçamento anual';
    budget.getCell(row++, 1).value = 'Preencha os valores mensais previstos.';

    const writeSection = (title: string, lines: FixtureLine[]) => {
      const header = budget.getRow(row++);
      header.getCell(1).value = title;
      header.getCell(2).value = 'Grupo';
      header.getCell(3).value = 'Conta';
      headerCells.forEach((v, i) => {
        const cell = header.getCell(4 + i);
        cell.value = v;
        if (dateFormat) cell.numFmt = dateFormat;
      });
      header.getCell(16).value = 'Total';
      header.getCell(17).value = 'Média/mês';
      header.getCell(18).value = '% do total';
      const zero = opts.blankZeros ? '' : '-';
      for (const line of lines) {
        const r = budget.getRow(row++);
        r.getCell(1).value = line.name;
        if (line.group) r.getCell(2).value = line.group;
        if (line.account) r.getCell(3).value = line.account;
        line.months.forEach((v, i) => {
          if (opts.numericAmounts) {
            r.getCell(4 + i).value = v / 100;
            return;
          }
          const text = money(v, zero);
          if (text !== '') r.getCell(4 + i).value = text;
        });
        const sum = line.months.reduce((a, b) => a + b, 0);
        const shown = opts.wrongLineTotal && line.name === 'Renda' ? 100 : sum;
        r.getCell(16).value = opts.numericAmounts ? shown / 100 : money(shown);
        r.getCell(17).value = money(Math.round(sum / 12));
      }
      const total = budget.getRow(row++);
      total.getCell(1).value = `Total ${title}`;
      for (let i = 0; i < 12; i += 1) {
        total.getCell(4 + i).value = money(lines.reduce((a, l) => a + l.months[i]!, 0));
      }
      total.getCell(16).value = money(
        lines.reduce((a, l) => a + l.months.reduce((x, y) => x + y, 0), 0),
      );
      row += 1; // blank row between sections
    };

    const pick = (title: 'Receitas' | 'Despesas' | 'Poupança', lines: FixtureLine[]) =>
      opts.emptySection === title ? [] : lines;
    let expense = pick('Despesas', EXPENSE);
    if (opts.extraLineAboveTotal) {
      expense = [
        ...expense,
        { name: 'Extra', group: 'Lazer', account: 'Cartão A', months: flat(1_000) },
      ];
    }
    if (opts.duplicateLine) {
      expense = [...expense, { ...EXPENSE[0]!, months: flat(10_000) }];
    }
    writeSection('Receitas', pick('Receitas', INCOME));
    writeSection('Despesas', expense);
    writeSection('Poupança', pick('Poupança', SAVING));
    for (const patch of opts.patchBudget ?? []) {
      budget.getCell(patch.row, colIndex(patch.col)).value = patch.value;
    }
  }

  const subs = sheet('Subscrições');
  if (subs) {
    subs.getCell('A1').value = 'Subscrições';
    subs.getCell('A2').value = 'Serviços recorrentes.';
    const header = [
      'Serviço',
      'Valor',
      'Periodicidade',
      'Custo mensal',
      'Conta',
      'Renovação',
      'Ativa',
    ];
    subs.getRow(3).values = header;
    const rows: Array<[string, number, string, number, string, string, string]> = [
      ['Streaming A', 1_200, 'Mensal', 1_200, 'Cartão A', '15/11/2026', 'Sim'],
      ['Seguro B', 24_000, 'Anual', 2_000, 'Conta Principal', '01/03/2027', 'Sim'],
      ['Ginásio C', 9_000, 'Trimestral', 3_000, 'Cartão A', '01/12/2026', 'Sim'],
      ['Revista D', 500, 'Semanal', 2_167, '', '', 'Sim'],
      ['Antigo E', 1_000, 'Mensal', 1_000, 'Cartão A', '', 'Não'],
    ];
    if (opts.zeroSubscription) rows.push(['Vazio G', 0, 'Mensal', 0, '', '', 'Sim']);
    if (opts.badPeriodicity) {
      rows.push(['Clube F', 1_000, 'Bimestral', 500, 'Cartão A', '', 'Sim']);
    }
    rows.forEach((r, i) => {
      const value = opts.numericAmounts ? r[1] / 100 : money(r[1]);
      subs.getRow(4 + i).values = [r[0], value, r[2], money(r[3]), r[4], r[5], r[6]];
    });
  }

  const assets = sheet('Património');
  if (assets) {
    const months = monthsFrom(startDate);
    const header = (first: string) => {
      const row = assets.addRow([first, 'Tipo', 'Notas']);
      months.forEach(([y, m], i) => {
        const yy = String(y % 100).padStart(2, '0');
        let value: ExcelJS.CellValue = `${MONTHS_PT[m]}. ${yy}`;
        if (opts.bareNetWorthHeaders) value = MONTHS_PT[m]!;
        else if (style === 'date') value = new Date(Date.UTC(y, m, 1));
        else if (style === 'serial') value = excelSerial(y, m);
        const cell = row.getCell(4 + i);
        cell.value = value;
        if (style === 'date' && !opts.bareNetWorthHeaders) cell.numFmt = 'mmm yy';
      });
      row.getCell(16).value = 'Variação';
    };
    const money2 = (v: number | null | '-'): string | number => {
      if (v === null) return '';
      if (v === '-') return '-';
      return opts.numericNetWorth ? v / 100 : money(v, '0,00\u00a0€');
    };
    const writeRows = (rows: NetWorthFixtureRow[], totalLabel: string) => {
      for (const r of rows) {
        const row = assets.addRow([r.name, r.tipo, r.notes ?? '']);
        r.months.forEach((v, i) => {
          const value = money2(v);
          if (value !== '') row.getCell(4 + i).value = value;
        });
        row.getCell(16).value = 'n/d'; // derived: ignored
      }
      const total = assets.addRow([totalLabel]);
      for (let i = 0; i < 12; i += 1) {
        const sum = rows.reduce((a, r) => a + num(r.months[i]), 0);
        total.getCell(4 + i).value = money2(sum);
      }
    };
    assets.addRow(['Património']);
    assets.addRow([]);
    header('Ativos');
    writeRows(
      [...(opts.netWorthRows?.assets ?? DEFAULT_ASSETS), ...(opts.extraAssets ?? [])],
      'Total ativos',
    );
    assets.addRow([]);
    let liabilityTotals: Array<number | null> = Array(12).fill(0);
    if (!opts.noCredits) {
      const liabilities = [
        ...(opts.netWorthRows?.liabilities ?? DEFAULT_LIABILITIES),
        ...(opts.extraLiabilities ?? []),
      ];
      header('Créditos');
      writeRows(liabilities, 'Total créditos');
      liabilityTotals = months.map((_, i) => liabilities.reduce((a, r) => a + num(r.months[i]), 0));
      assets.addRow([]);
    }
    const net = assets.addRow(['Património líquido']);
    for (let i = 0; i < 12; i += 1) {
      net.getCell(4 + i).value = money2(
        [...(opts.netWorthRows?.assets ?? DEFAULT_ASSETS), ...(opts.extraAssets ?? [])].reduce(
          (a, r) => a + num(r.months[i]),
          0,
        ) - liabilityTotals[i]!,
      );
    }
    for (const patch of opts.patchNetWorth ?? []) {
      assets.getCell(patch.row, colIndex(patch.col)).value = patch.value;
    }
  }
  const goals = sheet('Objetivos');
  if (goals) {
    goals.addRow(['Objetivos']);
    goals.addRow([
      'Objetivo',
      'Meta',
      'Saldo atual',
      'Contribuição mensal',
      'Falta',
      'Meses até à meta',
      'Data prevista',
      'Progresso',
    ]);
    const cellMoney = (v: number | null): string | number => {
      if (v === null) return '';
      return opts.numericNetWorth ? v / 100 : money(v);
    };
    for (const g of [...DEFAULT_GOALS, ...(opts.extraGoals ?? [])]) {
      const row = goals.addRow([
        g.name,
        cellMoney(g.target),
        cellMoney(g.saved),
        cellMoney(g.contribution),
        // derived columns: never read, may hold anything a formula produced
        g.target === null ? '#DIV/0!' : cellMoney(g.target - g.saved),
        g.target === null ? '' : 60,
        g.target === null ? '' : '01/10/2031',
        g.target === null ? '' : '0%',
      ]);
      if (g.saved === 0) row.getCell(3).value = opts.numericNetWorth ? 0 : '-';
    }
    for (const patch of opts.patchGoals ?? []) {
      goals.getCell(patch.row, colIndex(patch.col)).value = patch.value;
    }
  }
  const extra = sheet('Folha2');
  if (extra) extra.addRow(['Rascunho']);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A one-entry deflated zip: with a few KB of input it unpacks to `unpackedBytes` of zeros. */
export function zipBomb(unpackedBytes: number, entryName = 'xl/worksheets/sheet1.xml'): Buffer {
  const data = Buffer.alloc(unpackedBytes);
  const body = deflateRawSync(data);
  const name = Buffer.from(entryName);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const dirOffset = local.length + name.length + body.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(dirOffset, 16);
  return Buffer.concat([local, name, body, central, name, end]);
}
