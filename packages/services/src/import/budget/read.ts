import { ValidationError } from '../../context.js';
import { parseXlsxSheets, type TypedCell } from '../xlsx.js';
import { MAX_IMPORT_BYTES } from '../types.js';

/** The sheets of the budget workbook this import reads, as rows of cell text (values only). */
export type BudgetWorkbook = {
  config: TypedCell[][];
  budget: TypedCell[][];
  /** `null` when the workbook has no such sheet. */
  subscriptions: TypedCell[][] | null;
  /** Património: assets and credits. `null` when the workbook has no such sheet. */
  patrimonio: TypedCell[][] | null;
  /** Objetivos: savings goals. `null` when the workbook has no such sheet. */
  objetivos: TypedCell[][] | null;
};

/** Trimmed, lower-cased, accent-free, single-spaced: how names are compared throughout the import. */
export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const SHEETS = {
  config: 'Config',
  budget: 'Orçamento',
  subscriptions: 'Subscrições',
  patrimonio: 'Património',
  objetivos: 'Objetivos',
} as const;

/** The file cannot be read as a workbook at all (the message says why, in English). */
export const unreadableFile = (message: string) =>
  new ValidationError(message, [], 'unreadable_file');
const missingSheet = (sheet: string) =>
  new ValidationError(`The workbook has no "${sheet}" sheet`, [], 'missing_sheet', { sheet });

/**
 * Reads the Config, Orçamento, Subscrições, Património and Objetivos sheets through the
 * hardened XLSX reader (canonical archive rebuild, size, row, column and cell caps). Only stored
 * cell values are read: formulas are never evaluated and formatting is ignored. The other sheets
 * (Painel, Folha2) are never opened. Sheets are matched by name regardless of case and accents.
 */
export async function readBudgetWorkbook(bytes: Buffer): Promise<BudgetWorkbook> {
  if (bytes.length === 0) throw unreadableFile('The file is empty');
  if (bytes.length > MAX_IMPORT_BYTES)
    throw unreadableFile('The file is too large (maximum 10 MB)');
  let sheets: Awaited<ReturnType<typeof parseXlsxSheets>>;
  try {
    sheets = await parseXlsxSheets(
      bytes,
      Object.values(SHEETS),
      (name, wanted) => normalizeName(name) === normalizeName(wanted),
    );
  } catch (error) {
    // Not an archive, corrupt, or over the reader's caps: one reason for the UI. Failures that
    // already carry a code (e.g. too_many_rows) keep it.
    if (error instanceof ValidationError && error.code === undefined) {
      throw unreadableFile(error.message);
    }
    throw error;
  }
  const config = sheets.get(SHEETS.config);
  const budget = sheets.get(SHEETS.budget);
  if (!config) throw missingSheet(SHEETS.config);
  if (!budget) throw missingSheet(SHEETS.budget);
  return {
    config,
    budget,
    subscriptions: sheets.get(SHEETS.subscriptions) ?? null,
    patrimonio: sheets.get(SHEETS.patrimonio) ?? null,
    objetivos: sheets.get(SHEETS.objetivos) ?? null,
  };
}
