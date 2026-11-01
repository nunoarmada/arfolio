import { z } from 'zod';
import { parseAmount, parseDate, type DateFormat } from '@arfolio/core';
import { ValidationError } from '../context.js';
import type { IngestRow } from '../pipeline.js';
import { foldHeader } from './headers.js';
import type { ParsedRow, ParsedTable } from './types.js';

const column = z.string().min(1).max(200);

/**
 * Which file columns hold what. Columns are named by their header text; `headerRow` is the
 * 0-based line of the header in the file (lines above it are title rows).
 *  - `debitColumn`/`creditColumn`: unsigned amounts, signed amount = credit - debit.
 *  - `feeColumn`: subtracted from the amount (Revolut). `currencyColumn`: rows in another
 *    currency than the account are reported as errors.
 *  - `skipRowsMatching`: rows whose first filled cell starts with one of these (case and accent
 *    insensitive) are skipped as summary rows (totals, balances).
 *  - `filterColumn`: only rows whose cell equals one of `equals` are imported.
 */
export const columnMappingSchema = z
  .strictObject({
    dateColumn: column,
    valueDateColumn: column.optional(),
    descriptionColumn: column,
    counterpartyColumn: column.optional(),
    amountColumn: column.optional(),
    debitColumn: column.optional(),
    creditColumn: column.optional(),
    feeColumn: column.optional(),
    currencyColumn: column.optional(),
    statusColumn: column.optional(),
    externalIdColumn: column.optional(),
    dateFormat: z.enum(['DMY', 'YMD', 'MDY', 'auto']),
    decimal: z.enum([',', '.']).optional(),
    headerRow: z.number().int().min(0).max(1_000),
    skipRowsMatching: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    invertSign: z.boolean().optional(),
    filterColumn: z
      .strictObject({ column, equals: z.array(z.string().max(200)).min(1).max(50) })
      .optional(),
  })
  .refine((m) => m.amountColumn || m.debitColumn || m.creditColumn, {
    message: 'map an amount column, or debit/credit columns',
  });

export type ColumnMapping = z.infer<typeof columnMappingSchema>;

const PENDING = /pending|pendente|reserved|authori[sz]ed/;
const MAX_DESCRIPTION = 1_000;
const MAX_COUNTERPARTY = 300;

function resolveColumn(headers: string[], name: string): number {
  const exact = headers.findIndex((h) => h.trim() === name.trim());
  const idx = exact >= 0 ? exact : headers.map(foldHeader).indexOf(foldHeader(name));
  if (idx < 0) throw new ValidationError(`Column "${name}" was not found in the file header`);
  return idx;
}

/** Dates may carry a time ("2026-03-01 08:15:00"); ISO-like dates are YMD whatever the setting. */
const MAX_NUMERIC_CELL = 64;

function dateOf(text: string, format: DateFormat): string {
  if (text.length > MAX_NUMERIC_CELL) throw new ValidationError('Invalid date');
  const token = text.trim().split(/[\sT]/)[0] ?? '';
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(token)) return parseDate(token, 'YMD');
  const compact = /^(\d{2})(\d{2})(\d{4})$|^(\d{4})(\d{2})(\d{2})$/.exec(token);
  if (compact) {
    if (compact[4] !== undefined)
      return parseDate(`${compact[4]}-${compact[5]}-${compact[6]}`, 'YMD');
    return parseDate(`${compact[1]}-${compact[2]}-${compact[3]}`, format === 'MDY' ? 'MDY' : 'DMY');
  }
  return parseDate(token, format);
}

/**
 * Plain numbers written by the XLSX reader ("-23.45") use a dot whatever the sheet's locale, so
 * a comma setting must not reinterpret them.
 *
 * Rule for XLSX amounts that look like "1.234" (digits, a dot, three or more digits): the reader
 * cannot tell a sheet number (1.234) from a text cell written with a thousands dot ("1.234" meaning
 * 1234), and guessing would scale the amount by 1000, so such cells are row errors whatever the
 * decimal setting. Text such as "1.234,56" is unaffected.
 */
function amountOf(text: string, decimal: ',' | '.' | undefined, kind: ParsedTable['kind']): number {
  if (text.length > MAX_NUMERIC_CELL) throw new ValidationError('Invalid amount');
  // A sheet number with 3+ decimals cannot be a 2-decimal amount; reading it as a thousands
  // grouping ("1.234" -> 1234.00) would silently multiply it, so report it instead.
  if (kind === 'xlsx' && /^-?\d+\.\d{3,}$/.test(text.trim())) {
    throw new ValidationError(`Amount has more than 2 decimals: ${text.trim()}`);
  }
  const plain = kind === 'xlsx' && /^-?\d+(\.\d{1,2})?$/.test(text.trim());
  return parseAmount(text, plain ? { decimal: '.' } : decimal ? { decimal } : {});
}

/**
 * Turns the data lines of a CSV/XLSX table into import rows, one result per line below the
 * header. Rows that are blank, summary lines or filtered out are reported as skipped; rows that
 * cannot be read are reported as errors (never thrown), so one bad line does not hide the rest.
 * Throws ValidationError only when the mapping does not fit the file (missing column, bad header).
 */
export function applyMapping(
  table: ParsedTable,
  rawMapping: ColumnMapping,
  opts: { currency: string },
): ParsedRow[] {
  const mapping = columnMappingSchema.parse(rawMapping);
  const header = table.grid[mapping.headerRow];
  if (!header) throw new ValidationError('The header row is beyond the end of the file');

  const col = (name: string | undefined) => (name ? resolveColumn(header, name) : -1);
  const idx = {
    date: col(mapping.dateColumn),
    valueDate: col(mapping.valueDateColumn),
    description: col(mapping.descriptionColumn),
    counterparty: col(mapping.counterpartyColumn),
    amount: col(mapping.amountColumn),
    debit: col(mapping.debitColumn),
    credit: col(mapping.creditColumn),
    fee: col(mapping.feeColumn),
    currency: col(mapping.currencyColumn),
    status: col(mapping.statusColumn),
    externalId: col(mapping.externalIdColumn),
    filter: col(mapping.filterColumn?.column),
  };
  const skipPrefixes = (mapping.skipRowsMatching ?? []).map(foldHeader);
  const filterValues = new Set((mapping.filterColumn?.equals ?? []).map(foldHeader));

  const out: ParsedRow[] = [];
  for (let i = mapping.headerRow + 1; i < table.grid.length; i += 1) {
    const cells = table.grid[i]!;
    const line = i + 1;
    const cell = (at: number) => (at >= 0 ? (cells[at] ?? '').trim() : '');

    const first = cells.find((c) => c.trim() !== '');
    if (first === undefined) {
      out.push({ line, status: 'skipped', reason: 'empty' });
      continue;
    }
    const foldedFirst = foldHeader(first);
    if (skipPrefixes.some((p) => foldedFirst.startsWith(p))) {
      out.push({ line, status: 'skipped', reason: 'summary' });
      continue;
    }
    if (idx.filter >= 0 && !filterValues.has(foldHeader(cell(idx.filter)))) {
      out.push({ line, status: 'skipped', reason: 'filtered' });
      continue;
    }
    const dateText = cell(idx.date);
    if (dateText === '') {
      // A line without a date is a note or total, not a transaction.
      out.push({ line, status: 'skipped', reason: 'summary' });
      continue;
    }

    try {
      const bookingDate = dateOf(dateText, mapping.dateFormat);
      const valueText = cell(idx.valueDate);
      const description = cell(idx.description);
      if (description === '') throw new ValidationError('Missing description');

      let amount: number;
      if (idx.amount >= 0) {
        const text = cell(idx.amount);
        if (text === '') throw new ValidationError('Missing amount');
        amount = amountOf(text, mapping.decimal, table.kind);
      } else {
        const debit = cell(idx.debit);
        const credit = cell(idx.credit);
        if (debit === '' && credit === '') throw new ValidationError('Missing amount');
        const d = debit === '' ? 0 : Math.abs(amountOf(debit, mapping.decimal, table.kind));
        const c = credit === '' ? 0 : Math.abs(amountOf(credit, mapping.decimal, table.kind));
        amount = c - d;
      }
      const fee = cell(idx.fee);
      if (fee !== '') amount -= amountOf(fee, mapping.decimal, table.kind);
      if (mapping.invertSign) amount = -amount;

      const rowCurrency = cell(idx.currency).toUpperCase();
      if (rowCurrency !== '' && rowCurrency !== opts.currency) {
        throw new ValidationError(
          `Row currency (${rowCurrency}) differs from the account currency (${opts.currency})`,
        );
      }
      const externalId = cell(idx.externalId);
      if (externalId.length > 200) throw new ValidationError('External id is too long');
      const counterparty = cell(idx.counterparty);

      const row: IngestRow = {
        bookingDate,
        amount: amount === 0 ? 0 : amount,
        currency: opts.currency,
        description: description.slice(0, MAX_DESCRIPTION),
      };
      if (valueText !== '') row.valueDate = dateOf(valueText, mapping.dateFormat);
      if (counterparty !== '') row.counterparty = counterparty.slice(0, MAX_COUNTERPARTY);
      if (externalId !== '') row.externalId = externalId;
      if (idx.status >= 0)
        row.status = PENDING.test(foldHeader(cell(idx.status))) ? 'pending' : 'booked';
      out.push({ line, status: 'ok', row });
    } catch (error) {
      out.push({
        line,
        status: 'error',
        error: error instanceof Error ? error.message : 'Invalid row',
      });
    }
  }
  return out;
}
