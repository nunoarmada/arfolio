import { AmountParseError, parseAmount, type BudgetKind } from '@arfolio/core';
import type { schema } from '@arfolio/db';
import { MAX_AMOUNT_MINOR, ValidationError } from '../../context.js';
import type { TypedCell } from '../xlsx.js';
import { normalizeName, type BudgetWorkbook } from './read.js';

export type BudgetImportWarningCode =
  | 'total_mismatch'
  | 'month_header_mismatch'
  | 'unknown_periodicity'
  | 'empty_section'
  | 'duplicate_line_name'
  | 'zero_value_subscription'
  | 'unknown_net_worth_type'
  | 'derived_target'
  | 'saved_ignored'
  | 'saved_differs'
  | 'currency_mismatch'
  | 'goal_unlinked';

/** A finding the UI words in the user's language: a code and the values to show, never free text. */
export type BudgetImportWarning = {
  code: BudgetImportWarningCode;
  params: Record<string, string | number>;
};

export type SubscriptionCadence = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export type ParsedBudgetLine = {
  kind: BudgetKind;
  name: string;
  /** The line's Grupo cell; null when empty. */
  group: string | null;
  /** The line's Conta cell; null when empty. */
  account: string | null;
  /** Planned amounts, minor units, 12 months from the start month. */
  amounts: number[];
};

export type ParsedSubscription = {
  name: string;
  /** Signed minor units: always negative (outgoing). */
  amount: number;
  cadence: SubscriptionCadence;
  account: string | null;
};

/** One asset or credit row of Património: its non-blank month cells, at each month's last day. */
export type ParsedNetWorthRow<K extends string> = {
  name: string;
  /** The Tipo cell as written; '' when empty. */
  tipo: string;
  kind: K;
  notes: string | null;
  /**
   * Minor units, never negative: one per month that has ended by the import date and holds a real
   * figure (an explicit 0 included). Blank and "-" cells and months not yet ended are absent.
   */
  values: Array<{ asOf: string; amount: number }>;
};

export type ParsedPatrimonio = {
  assets: Array<ParsedNetWorthRow<schema.AssetKind>>;
  liabilities: Array<ParsedNetWorthRow<schema.LiabilityKind>>;
};

export type ParsedGoal = {
  name: string;
  kind: schema.GoalKind;
  /** Minor units; null when blank, "-" or 0 (and always null for the emergency fund: derived). */
  target: number | null;
  /** Minor units; null when blank, "-" or 0 (the budget line's plan is used then). */
  contribution: number | null;
  /**
   * Saldo atual (0 when blank or "-"). Committing stores a positive one as the goal's saved
   * baseline, dated the import date; a goal linked to an account ignores it (`saved_ignored`).
   */
  saved: number;
};

export type ParsedBudgetSheet = {
  /** `yyyy-mm-01`, from Config B3. */
  startMonth: string;
  /** Config B4; null when empty. */
  emergencyFundMonths: number | null;
  /** Config's account names (column A, from row 7). */
  accounts: string[];
  /** Config's expense group names (column C, from row 7). */
  groups: string[];
  lines: ParsedBudgetLine[];
  subscriptions: ParsedSubscription[];
  /** Subscriptions marked inactive ("Não") that were left out. */
  subscriptionsSkipped: number;
  /** `null` when the workbook has no Património sheet. */
  patrimonio: ParsedPatrimonio | null;
  /** `null` when the workbook has no Objetivos sheet. */
  goals: ParsedGoal[] | null;
  warnings: BudgetImportWarning[];
};

const MAX_NAME = 80;
const MAX_NET_WORTH_NAME = 120;
const MAX_NOTES = 2_000;
/** Per import (ruling): a household's real list is far below these. */
const MAX_ASSETS = 200;
const MAX_LIABILITIES = 200;
const MAX_GOALS = 100;
const MAX_ACCOUNT_NAME = 120;
const MAX_EMERGENCY_MONTHS = 120;
/** Business caps: a real household budget is far below these. */
const MAX_LINES_PER_SECTION = 500;
const MAX_ACCOUNTS = 200;
const MAX_GROUPS = 200;
const MAX_SUBSCRIPTIONS = 500;

const tooMany = (section: string, max: number) =>
  new ValidationError(`Too many rows in ${section} (maximum ${max})`, [], 'too_many_rows', {
    section,
    max,
  });

const SECTIONS: Record<string, { title: string; kind: BudgetKind }> = {
  receitas: { title: 'Receitas', kind: 'income' },
  despesas: { title: 'Despesas', kind: 'expense' },
  poupanca: { title: 'Poupança', kind: 'saving' },
};
const CADENCES: Record<string, SubscriptionCadence> = {
  mensal: 'monthly',
  trimestral: 'quarterly',
  anual: 'yearly',
  semanal: 'weekly',
};
const INACTIVE = new Set(['nao', 'no', 'n', 'false', '0']);
const MONTH_ABBREVIATIONS = [
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

// Layout columns of the Orçamento sheet (0-based): A name, B group, C account, D..O months, P total.
const COL_GROUP = 1;
const COL_ACCOUNT = 2;
const COL_FIRST_MONTH = 3;
const COL_TOTAL = 15;

/** Zero-based column to its spreadsheet letters: 0 is A, 25 is Z, 26 is AA. */
function columnLetters(col: number): string {
  let letters = '';
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

/** A cell as the UI names it: the sheet and its A1 reference (zero-based row and column in). */
type CellRef = { sheet: string; cell: string };
const cellRef = (sheet: string, row: number, col: number): CellRef => ({
  sheet,
  cell: `${columnLetters(col)}${row + 1}`,
});
const where = ({ sheet, cell }: CellRef) => `${sheet} ${cell}`;
const MAX_SHOWN_VALUE = 40;
type Grid = TypedCell[][];
const raw = (grid: Grid, row: number, col: number): TypedCell => grid[row]?.[col] ?? '';
const cell = (grid: Grid, row: number, col: number) => String(raw(grid, row, col)).trim();
const isTotal = (name: string) => /^total\b/.test(normalizeName(name));

type YearMonth = { year: number; month: number };

/**
 * A date or month as the sheets write it: dd/mm/yyyy, yyyy-mm-dd (a date cell), an Excel date
 * serial, or a pt-PT abbreviated month with a 2- or 4-digit year ("out. 26", "out 26"). Returns the
 * year and month (1..12), or null when it is none of those or not a real date.
 */
function parseYearMonth(text: string): YearMonth | null {
  const value = text.trim();
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dmy || iso) {
    const [year, month, day] = dmy
      ? [Number(dmy[3]), Number(dmy[2]), Number(dmy[1])]
      : [Number(iso![1]), Number(iso![2]), Number(iso![3])];
    const probe = new Date(Date.UTC(year, month - 1, day));
    const real =
      probe.getUTCFullYear() === year &&
      probe.getUTCMonth() === month - 1 &&
      probe.getUTCDate() === day;
    return real ? { year, month } : null;
  }
  if (/^\d{4,6}$/.test(value)) {
    const serial = Number(value);
    if (serial < 1 || serial > 2_958_465) return null;
    const date = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
  }
  const named = /^(\p{L}+)\.?\s*(\d{2}|\d{4})$/u.exec(normalizeName(value));
  if (named) {
    const month = MONTH_ABBREVIATIONS.indexOf(named[1]!) + 1;
    if (month === 0) return null;
    const year = Number(named[2]);
    return { year: named[2]!.length === 2 ? 2000 + year : year, month };
  }
  return null;
}

const monthIndex = ({ year, month }: YearMonth) => year * 12 + month - 1;
const startMonthOf = ({ year, month }: YearMonth) =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;

/**
 * A JS number as minor units (2 decimals), without float arithmetic: its shortest decimal string
 * (exponent form included) is rounded half to even with BigInt. 12.125 is 1212, 0.1 + 0.2 is 30.
 */
export function numberToMinor(n: number): number {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(n));
  if (!Number.isFinite(n) || !match) throw new ValidationError('The number is not a valid amount');
  if (Math.abs(n) >= 1e13)
    throw new ValidationError('The amount is too large', [], 'amount_too_large');
  const digits = BigInt(`${match[2]}${match[3] ?? ''}`);
  const scale = (match[3]?.length ?? 0) - Number(match[4] ?? 0);
  let minor: bigint;
  if (scale <= 2) {
    minor = digits * 10n ** BigInt(2 - scale);
  } else {
    const divisor = 10n ** BigInt(scale - 2);
    minor = digits / divisor;
    const rest = digits % divisor;
    const twice = rest * 2n;
    if (twice > divisor || (twice === divisor && minor % 2n === 1n)) minor += 1n;
  }
  const signed = match[1] ? -minor : minor;
  if (signed > BigInt(MAX_AMOUNT_MINOR) || signed < -BigInt(MAX_AMOUNT_MINOR)) {
    throw new ValidationError('The amount is too large', [], 'amount_too_large');
  }
  return Number(signed);
}

/**
 * Money as the sheets hold it: a number cell (or a formula's stored number) is converted exactly,
 * text is read as a pt-PT amount; "-", a dash and an empty cell are zero. Throws on anything else.
 */
function parseMoney(value: TypedCell, ref: CellRef): number {
  const invalid = (shown: string) =>
    new ValidationError(`${where(ref)}: "${shown}" is not an amount`, [], 'invalid_amount', {
      ...ref,
      value: shown,
    });
  if (typeof value === 'number') {
    try {
      return numberToMinor(value);
    } catch {
      throw invalid(String(value).slice(0, MAX_SHOWN_VALUE));
    }
  }
  const text = value.trim();
  if (text === '' || /^[-\u2013\u2014]$/.test(text)) return 0;
  try {
    const minor = parseAmount(text);
    if (Math.abs(minor) > MAX_AMOUNT_MINOR) throw invalid(text.slice(0, MAX_SHOWN_VALUE));
    return minor;
  } catch (error) {
    if (error instanceof AmountParseError) throw invalid(text.slice(0, MAX_SHOWN_VALUE));
    throw error;
  }
}

function checkedName(value: string, max: number, ref: CellRef): string {
  if (value.length > max) {
    throw new ValidationError(
      `${where(ref)}: the name is longer than ${max} characters`,
      [],
      'name_too_long',
      { name: value, max },
    );
  }
  return value;
}

const invalidConfig = (cell: string, message: string) =>
  new ValidationError(message, [], 'invalid_config', { cell });

function readConfig(config: Grid) {
  const start = parseYearMonth(cell(config, 2, 1));
  if (!start) throw invalidConfig('B3', 'Config B3 must hold the start date of the budget year');
  const rawMonths = cell(config, 3, 1);
  let emergencyFundMonths: number | null = null;
  if (rawMonths !== '') {
    const months = Number(rawMonths.replace(',', '.'));
    if (!Number.isInteger(months) || months < 0 || months > MAX_EMERGENCY_MONTHS) {
      throw invalidConfig('B4', 'Config B4 must be a whole number of months');
    }
    emergencyFundMonths = months;
  }
  const column = (col: number, maxLength: number, section: string, cap: number): string[] => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (let row = 6; cell(config, row, col) !== ''; row += 1) {
      const name = checkedName(cell(config, row, col), maxLength, cellRef('Config', row, col));
      if (seen.has(normalizeName(name))) continue;
      seen.add(normalizeName(name));
      names.push(name);
      if (names.length > cap) throw tooMany(section, cap);
    }
    return names;
  };
  return {
    start,
    emergencyFundMonths,
    accounts: column(0, MAX_ACCOUNT_NAME, 'accounts', MAX_ACCOUNTS),
    groups: column(2, MAX_NAME, 'groups', MAX_GROUPS),
  };
}

function sectionOf(grid: Grid, row: number) {
  const section = SECTIONS[normalizeName(cell(grid, row, 0))];
  if (!section) return null;
  const looksLikeHeader =
    normalizeName(cell(grid, row, COL_GROUP)) === 'grupo' ||
    normalizeName(cell(grid, row, COL_ACCOUNT)) === 'conta';
  return looksLikeHeader ? section : null;
}

function readBudget(grid: Grid, start: YearMonth, warnings: BudgetImportWarning[]) {
  const sheet = 'Orçamento';
  const lines: ParsedBudgetLine[] = [];
  const usedNames = new Set<string>();
  /** Last suffix handed out per repeated name, so renaming stays linear. */
  const lastSuffix = new Map<string, number>();
  let headerMismatch: string | null = null;
  let sections = 0;

  for (let row = 0; row < grid.length; row += 1) {
    const section = sectionOf(grid, row);
    if (!section) continue;
    sections += 1;

    const expected = monthIndex(start);
    const aligned = Array.from({ length: 12 }, (_, i) => {
      const month = parseYearMonth(cell(grid, row, COL_FIRST_MONTH + i));
      return month !== null && monthIndex(month) === expected + i;
    }).every(Boolean);
    if (!aligned && headerMismatch === null) headerMismatch = section.title;

    let count = 0;
    let linesTotal = 0;
    for (row += 1; row < grid.length; row += 1) {
      if (sectionOf(grid, row)) {
        row -= 1; // the outer loop reads this header next
        break;
      }
      const name = cell(grid, row, 0);
      if (isTotal(name)) {
        const found = tryMoney(raw(grid, row, COL_TOTAL));
        if (found !== null && found !== linesTotal) {
          warnings.push({
            code: 'total_mismatch',
            params: { section: section.title, expected: linesTotal, found },
          });
        }
        break;
      }
      if (name === '') continue;
      if (count >= MAX_LINES_PER_SECTION) throw tooMany(section.title, MAX_LINES_PER_SECTION);
      checkedName(name, MAX_NAME, cellRef(sheet, row, 0));

      const amounts = Array.from({ length: 12 }, (_, i) => {
        const col = COL_FIRST_MONTH + i;
        const ref = cellRef(sheet, row, col);
        const amount = parseMoney(raw(grid, row, col), ref);
        if (amount < 0) {
          throw new ValidationError(
            `${where(ref)}: planned amounts cannot be negative`,
            [],
            'negative_amount',
            { ...ref },
          );
        }
        return amount;
      });
      const total = amounts.reduce((a, b) => a + b, 0);
      const found = tryMoney(raw(grid, row, COL_TOTAL));
      if (found !== null && found !== total) {
        warnings.push({
          code: 'total_mismatch',
          params: { section: section.title, line: name, expected: total, found },
        });
      }
      linesTotal += total;

      const baseKey = `${section.kind}:${normalizeName(name)}`;
      let unique = name;
      if (usedNames.has(baseKey)) {
        // "<name> (n)" must still fit the name limit, so the base is cut when needed.
        let n = lastSuffix.get(baseKey) ?? 1;
        do {
          n += 1;
          const suffix = ` (${n})`;
          unique = `${name.slice(0, MAX_NAME - suffix.length).trimEnd()}${suffix}`;
        } while (usedNames.has(`${section.kind}:${normalizeName(unique)}`));
        lastSuffix.set(baseKey, n);
        warnings.push({
          code: 'duplicate_line_name',
          params: { section: section.title, name },
        });
      }
      usedNames.add(`${section.kind}:${normalizeName(unique)}`);
      const group = cell(grid, row, COL_GROUP);
      const account = cell(grid, row, COL_ACCOUNT);
      lines.push({
        kind: section.kind,
        name: unique,
        group: group === '' ? null : checkedName(group, MAX_NAME, cellRef(sheet, row, COL_GROUP)),
        account:
          account === ''
            ? null
            : checkedName(account, MAX_ACCOUNT_NAME, cellRef(sheet, row, COL_ACCOUNT)),
        amounts,
      });
      count += 1;
    }
    if (count === 0) {
      warnings.push({ code: 'empty_section', params: { section: section.title } });
    }
  }
  if (sections === 0) {
    throw new ValidationError(
      `The "${sheet}" sheet has no Receitas, Despesas or Poupança section`,
      [],
      'missing_section',
      { section: 'Receitas, Despesas, Poupança' },
    );
  }
  return { lines, headerMismatch };
}

/** The value of a cross-check cell, or null when it is not money (the check is then skipped). */
function tryMoney(value: TypedCell): number | null {
  if (value === '') return null;
  try {
    return parseMoney(value, { sheet: 'total', cell: '' });
  } catch (error) {
    if (error instanceof ValidationError) return null;
    throw error;
  }
}

function readSubscriptions(
  grid: Grid,
  warnings: BudgetImportWarning[],
): { subscriptions: ParsedSubscription[]; skipped: number } {
  const sheet = 'Subscrições';
  const headerRow = 2;
  const labels = (grid[headerRow] ?? []).map((c) => normalizeName(String(c)));
  const column = (label: string) => labels.indexOf(label);
  const [name, value, periodicity] = [column('servico'), column('valor'), column('periodicidade')];
  if (name < 0 || value < 0 || periodicity < 0) {
    const missing = [
      ...(name < 0 ? ['Serviço'] : []),
      ...(value < 0 ? ['Valor'] : []),
      ...(periodicity < 0 ? ['Periodicidade'] : []),
    ];
    throw new ValidationError(
      `${sheet} row 3 must have the columns Serviço, Valor and Periodicidade`,
      [],
      'missing_columns',
      { sheet, columns: missing.join(', ') },
    );
  }
  const account = column('conta');
  const active = column('ativa');

  const subscriptions: ParsedSubscription[] = [];
  let skipped = 0;
  let zeroValue = 0;
  let rows = 0;
  for (let row = headerRow + 1; row < grid.length; row += 1) {
    const service = cell(grid, row, name);
    if (service === '') continue;
    if (isTotal(service)) break;
    if ((rows += 1) > MAX_SUBSCRIPTIONS) throw tooMany(sheet, MAX_SUBSCRIPTIONS);
    if (active >= 0 && INACTIVE.has(normalizeName(cell(grid, row, active)))) {
      skipped += 1;
      continue;
    }
    const price = Math.abs(parseMoney(raw(grid, row, value), cellRef(sheet, row, value)));
    if (price === 0) {
      zeroValue += 1; // an unused template row, or a free service: nothing to import
      continue;
    }
    const rawPeriodicity = cell(grid, row, periodicity);
    const cadence = CADENCES[normalizeName(rawPeriodicity)];
    if (!cadence) {
      warnings.push({
        code: 'unknown_periodicity',
        params: { name: service, value: rawPeriodicity },
      });
      continue;
    }
    const accountName = account >= 0 ? cell(grid, row, account) : '';
    subscriptions.push({
      name: checkedName(service, MAX_NAME, cellRef(sheet, row, name)),
      amount: -price,
      cadence,
      account:
        accountName === ''
          ? null
          : checkedName(accountName, MAX_ACCOUNT_NAME, cellRef(sheet, row, account)),
    });
  }
  if (zeroValue > 0) {
    warnings.push({ code: 'zero_value_subscription', params: { count: zeroValue } });
  }
  return { subscriptions, skipped };
}

// ---------------------------------------------------------------------------------------------
// Património and Objetivos

const ASSET_KIND: Record<string, schema.AssetKind> = {
  imovel: 'real_estate',
  viatura: 'vehicle',
  investimentos: 'investment',
  liquidez: 'cash',
};
const LIABILITY_KIND: Record<string, schema.LiabilityKind> = {
  hipoteca: 'mortgage',
  emprestimo: 'loan',
  divida: 'debt',
  cartao: 'card',
};
const EMERGENCY_FUND_NAMES = new Set(['fundo emergencia', 'fundo de emergencia', 'emergency fund']);
// Património layout (0-based): A name, B Tipo, C Notas, D..O the twelve months.
const COL_TIPO = 1;
const COL_NOTES = 2;
const COL_NET_WORTH_MONTHS = 3;

const lastDayOf = ({ year, month }: YearMonth): string => {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

/**
 * The month a Património header stands for: the header's own month and year when it has them (a
 * date, a serial or "out. 26"); a bare month name ("out") is placed in the twelve months from the
 * budget's start; anything else is read by position from the start.
 */
function headerMonth(text: string, position: number, start: YearMonth): YearMonth {
  const dated = parseYearMonth(text);
  if (dated) return dated;
  const first = monthIndex(start);
  const bare = /^(\p{L}+)\.?$/u.exec(normalizeName(text));
  const month = bare ? MONTH_ABBREVIATIONS.indexOf(bare[1]!) + 1 : 0;
  if (month > 0) {
    for (const year of [start.year, start.year + 1]) {
      const index = monthIndex({ year, month });
      if (index >= first && index < first + 12) return { year, month };
    }
  }
  const index = first + position;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** "name", else "name (2)", "name (3)"... within `used` (normalised), cut to fit `max`. */
function uniqueName(name: string, used: Set<string>, max: number): string {
  let unique = name;
  for (let n = 2; used.has(normalizeName(unique)); n += 1) {
    const suffix = ` (${n})`;
    unique = `${name.slice(0, max - suffix.length).trimEnd()}${suffix}`;
  }
  used.add(normalizeName(unique));
  return unique;
}

/** A cell that is empty or only a dash: no value at all. */
const isBlank = (value: TypedCell) => {
  const text = String(value).trim();
  return text === '' || /^[-–—]$/.test(text);
};

/** Money that may not be negative. */
function parseNonNegative(value: TypedCell, ref: CellRef): number {
  const amount = parseMoney(value, ref);
  if (amount < 0) {
    throw new ValidationError(`${where(ref)}: values cannot be negative`, [], 'negative_amount', {
      ...ref,
    });
  }
  return amount;
}

function readPatrimonio(
  grid: Grid,
  start: YearMonth,
  today: string,
  warnings: BudgetImportWarning[],
) {
  const sheet = 'Património';
  const assets: ParsedPatrimonio['assets'] = [];
  const liabilities: ParsedPatrimonio['liabilities'] = [];
  const used = { asset: new Set<string>(), liability: new Set<string>() };
  // One cap per side, however many header blocks the sheet repeats.
  const counts = { asset: 0, liability: 0 };
  const headerOf = (row: number) => {
    if (normalizeName(cell(grid, row, COL_TIPO)) !== 'tipo') return null;
    const label = normalizeName(cell(grid, row, 0));
    return label === 'ativos' ? 'asset' : label === 'creditos' ? 'liability' : null;
  };
  let sections = 0;

  for (let row = 0; row < grid.length; row += 1) {
    const side = headerOf(row);
    if (!side) continue;
    sections += 1;
    const title = side === 'asset' ? 'Ativos' : 'Créditos';
    const monthDays = Array.from({ length: 12 }, (_, i) =>
      lastDayOf(headerMonth(cell(grid, row, COL_NET_WORTH_MONTHS + i), i, start)),
    );
    const seenMonths = new Set<string>();
    for (const day of monthDays) {
      if (seenMonths.has(day)) {
        throw new ValidationError(
          `${sheet} row ${row + 1}: two columns are the same month`,
          [],
          'duplicate_month',
          { sheet, month: day.slice(0, 7) },
        );
      }
      seenMonths.add(day);
    }
    const cap = side === 'asset' ? MAX_ASSETS : MAX_LIABILITIES;
    const kinds = side === 'asset' ? ASSET_KIND : LIABILITY_KIND;

    for (row += 1; row < grid.length; row += 1) {
      if (headerOf(row)) {
        row -= 1; // the outer loop reads this header next
        break;
      }
      const name = cell(grid, row, 0);
      if (isTotal(name) || normalizeName(name).startsWith('patrimonio liquido')) break;
      if (name === '') continue;
      if (counts[side] >= cap) throw tooMany(side === 'asset' ? 'assets' : 'liabilities', cap);
      counts[side] += 1;
      checkedName(name, MAX_NET_WORTH_NAME, cellRef(sheet, row, 0));

      const tipo = cell(grid, row, COL_TIPO);
      const kind = kinds[normalizeName(tipo)] ?? 'other';
      if (kind === 'other' && tipo !== '' && normalizeName(tipo) !== 'outro') {
        warnings.push({ code: 'unknown_net_worth_type', params: { name, value: tipo } });
      }
      const notes = cell(grid, row, COL_NOTES);
      if (notes.length > MAX_NOTES) {
        throw new ValidationError(
          `${where(cellRef(sheet, row, COL_NOTES))}: the notes are longer than ${MAX_NOTES} characters`,
          [],
          'name_too_long',
          { name: `${notes.slice(0, MAX_SHOWN_VALUE)}…`, max: MAX_NOTES },
        );
      }
      const values: Array<{ asOf: string; amount: number }> = [];
      for (let i = 0; i < 12; i += 1) {
        const col = COL_NET_WORTH_MONTHS + i;
        const value = raw(grid, row, col);
        // Blank and "-" cells say nothing, and a month that has not ended is a projection: only
        // a real figure for a past month (an explicit 0 included) is a value.
        if (isBlank(value) || monthDays[i]! > today) continue;
        values.push({
          asOf: monthDays[i]!,
          amount: parseNonNegative(value, cellRef(sheet, row, col)),
        });
      }
      const unique = uniqueName(name, used[side], MAX_NET_WORTH_NAME);
      if (unique !== name) {
        warnings.push({ code: 'duplicate_line_name', params: { section: title, name } });
      }
      const parsed = { name: unique, tipo, notes: notes === '' ? null : notes, values };
      if (side === 'asset') assets.push({ ...parsed, kind: kind as schema.AssetKind });
      else liabilities.push({ ...parsed, kind: kind as schema.LiabilityKind });
    }
  }
  if (sections === 0) {
    throw new ValidationError(
      `The "${sheet}" sheet has no Ativos or Créditos section`,
      [],
      'missing_section',
      { section: 'Ativos, Créditos' },
    );
  }
  return { assets, liabilities };
}

function readGoals(grid: Grid, warnings: BudgetImportWarning[]): ParsedGoal[] {
  const sheet = 'Objetivos';
  const headerRow = grid.findIndex(
    (r) =>
      normalizeName(String(r[0] ?? '')) === 'objetivo' &&
      r.some((c) => normalizeName(String(c)) === 'meta'),
  );
  const labels = (grid[headerRow] ?? []).map((c) => normalizeName(String(c)));
  const [name, target, saved, contribution] = [
    labels.indexOf('objetivo'),
    labels.indexOf('meta'),
    labels.indexOf('saldo atual'),
    labels.indexOf('contribuicao mensal'),
  ];
  if (headerRow < 0 || target < 0 || contribution < 0) {
    throw new ValidationError(
      `The "${sheet}" sheet must have the columns Objetivo, Meta and Contribuição mensal`,
      [],
      'missing_columns',
      { sheet, columns: 'Objetivo, Meta, Contribuição mensal' },
    );
  }
  const goals: ParsedGoal[] = [];
  const used = new Set<string>();
  // Falta, Meses até à meta, Data prevista and Progresso are derived: never read.
  for (let row = headerRow + 1; row < grid.length; row += 1) {
    const goalName = cell(grid, row, name);
    if (goalName === '') continue;
    if (isTotal(goalName)) break;
    if (goals.length >= MAX_GOALS) throw tooMany('goals', MAX_GOALS);
    checkedName(goalName, MAX_NET_WORTH_NAME, cellRef(sheet, row, name));
    const optional = (col: number): number | null => {
      const value = raw(grid, row, col);
      if (isBlank(value)) return null;
      return parseNonNegative(value, cellRef(sheet, row, col)) || null;
    };
    const emergency = EMERGENCY_FUND_NAMES.has(normalizeName(goalName));
    const savedValue =
      saved >= 0 && !isBlank(raw(grid, row, saved))
        ? parseMoney(raw(grid, row, saved), cellRef(sheet, row, saved))
        : 0;
    const unique = uniqueName(goalName, used, MAX_NET_WORTH_NAME);
    if (unique !== goalName) {
      warnings.push({ code: 'duplicate_line_name', params: { section: sheet, name: goalName } });
    }
    const sheetTarget = optional(target);
    if (emergency) {
      warnings.push({ code: 'derived_target', params: { name: unique } });
    }
    goals.push({
      name: unique,
      kind: emergency ? 'emergency_fund' : 'generic',
      target: emergency ? null : sheetTarget,
      contribution: optional(contribution),
      saved: savedValue,
    });
  }
  return goals;
}

/**
 * Turns the sheets into the budget to import. Pure: no database. Totals are always computed from
 * the monthly amounts; the sheet's own Total cells are only compared (`total_mismatch`). Anything
 * unreadable is a ValidationError naming the cell; anything merely odd is a warning code.
 * `options.today` (YYYY-MM-DD, the household's day) is the import date: Património months that
 * end after it are projections and are not read; it defaults to today in UTC.
 */
export function parseBudgetWorkbook(
  workbook: BudgetWorkbook,
  options: { today?: string } = {},
): ParsedBudgetSheet {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const config = readConfig(workbook.config);
  const warnings: BudgetImportWarning[] = [];
  const { lines, headerMismatch } = readBudget(workbook.budget, config.start, warnings);
  if (headerMismatch !== null) {
    // Config B3 is the truth: the amounts are read by position.
    warnings.unshift({ code: 'month_header_mismatch', params: { section: headerMismatch } });
  }
  const subs = workbook.subscriptions
    ? readSubscriptions(workbook.subscriptions, warnings)
    : { subscriptions: [], skipped: 0 };
  const patrimonio = workbook.patrimonio
    ? readPatrimonio(workbook.patrimonio, config.start, today, warnings)
    : null;
  const goals = workbook.objetivos ? readGoals(workbook.objetivos, warnings) : null;
  const distinct = (names: string[]) => new Set(names.map(normalizeName)).size;
  const used = [...lines, ...subs.subscriptions].flatMap((r) => (r.account ? [r.account] : []));
  if (distinct([...config.accounts, ...used]) > MAX_ACCOUNTS)
    throw tooMany('accounts', MAX_ACCOUNTS);
  const usedGroups = lines.flatMap((l) => (l.group ? [`${l.kind}:${l.group}`] : []));
  const groupCount = new Set([
    ...config.groups.map((g) => `expense:${normalizeName(g)}`),
    ...usedGroups.map((g) => normalizeName(g)),
  ]).size;
  if (groupCount > MAX_GROUPS) throw tooMany('groups', MAX_GROUPS);
  return {
    startMonth: startMonthOf(config.start),
    emergencyFundMonths: config.emergencyFundMonths,
    accounts: config.accounts,
    groups: config.groups,
    lines,
    subscriptions: subs.subscriptions,
    subscriptionsSkipped: subs.skipped,
    patrimonio,
    goals,
    warnings,
  };
}
