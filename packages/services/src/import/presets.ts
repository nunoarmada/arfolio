import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, withHousehold, type Tx } from '@arfolio/db';
import {
  assertCanWrite,
  assertUuid,
  NotFoundError,
  parseInput,
  ValidationError,
  type ServiceCtx,
} from '../context.js';
import {
  AMOUNT_HEADERS,
  CREDIT_HEADERS,
  DATE_HEADERS,
  DEBIT_HEADERS,
  DESCRIPTION_HEADERS,
  VALUE_DATE_HEADERS,
  findHeader,
  foldHeader,
} from './headers.js';
import { columnMappingSchema, type ColumnMapping } from './mapping.js';
import type { ParsedTable } from './types.js';

const { importPreset } = schema;

export type PresetKey = 'generic' | 'revolut' | 'pt_bank';

const REVOLUT_HEADERS = [
  'type',
  'product',
  'started date',
  'completed date',
  'description',
  'amount',
  'fee',
  'currency',
  'state',
  'balance',
];
const PT_DATE_HEADERS = ['data mov', 'data movimento', 'data valor'];
const PT_DESCRIPTION = ['descricao', 'descritivo', 'movimento'];
const PT_AMOUNT = ['debito', 'credito', 'montante'];
/** Rows starting with these are totals/balances, not transactions. */
const DEFAULT_SKIP = ['total', 'subtotal', 'saldo', 'opening balance', 'closing balance'];

function foldedHeaders(table: ParsedTable): string[] {
  return table.headers.map(foldHeader);
}

/** The built-in layout the file's header line matches, or null (also null for OFX). */
export function detectPreset(table: ParsedTable): PresetKey | null {
  if (table.kind === 'ofx') return null;
  const h = foldedHeaders(table);
  if (REVOLUT_HEADERS.every((name) => h.includes(name))) return 'revolut';
  const has = (names: string[]) => names.some((n) => h.includes(n));
  if (has(PT_DATE_HEADERS) && has(PT_DESCRIPTION) && has(PT_AMOUNT)) return 'pt_bank';
  const hasAmount = has(AMOUNT_HEADERS) || has(DEBIT_HEADERS) || has(CREDIT_HEADERS);
  if (has(DATE_HEADERS) && has(DESCRIPTION_HEADERS) && hasAmount) return 'generic';
  return null;
}

function headerAt(table: ParsedTable, names: readonly string[]): string | undefined {
  const idx = findHeader(table.headers, names);
  return idx >= 0 ? table.headers[idx]!.trim() : undefined;
}

function required(value: string | undefined, what: string): string {
  if (!value) throw new ValidationError(`The file has no ${what} column`);
  return value;
}

/** The column mapping a built-in preset proposes for `table` (the user can adjust it). */
export function presetMapping(key: PresetKey, table: ParsedTable): ColumnMapping {
  const base = { headerRow: table.headerRow, skipRowsMatching: DEFAULT_SKIP };
  if (key === 'revolut') {
    return {
      ...base,
      dateColumn: 'Started Date',
      valueDateColumn: 'Completed Date',
      descriptionColumn: 'Description',
      amountColumn: 'Amount',
      feeColumn: 'Fee',
      currencyColumn: 'Currency',
      statusColumn: 'State',
      filterColumn: { column: 'State', equals: ['COMPLETED', 'PENDING'] },
      dateFormat: 'YMD',
      decimal: '.',
    };
  }
  const dateNames = key === 'pt_bank' ? ['data mov', 'data movimento', 'data valor'] : DATE_HEADERS;
  const dateColumn = required(headerAt(table, dateNames), 'date');
  const valueDateColumn = headerAt(table, VALUE_DATE_HEADERS);
  const debitColumn = headerAt(table, DEBIT_HEADERS);
  const creditColumn = headerAt(table, CREDIT_HEADERS);
  const amountColumn = headerAt(table, AMOUNT_HEADERS);
  const mapping: ColumnMapping = {
    ...base,
    dateColumn,
    descriptionColumn: required(
      headerAt(table, key === 'pt_bank' ? PT_DESCRIPTION : DESCRIPTION_HEADERS),
      'description',
    ),
    dateFormat: key === 'pt_bank' ? 'DMY' : 'auto',
    ...(key === 'pt_bank' ? { decimal: ',' as const } : {}),
  };
  if (valueDateColumn && valueDateColumn !== dateColumn) mapping.valueDateColumn = valueDateColumn;
  if (debitColumn || creditColumn) {
    if (debitColumn) mapping.debitColumn = debitColumn;
    if (creditColumn) mapping.creditColumn = creditColumn;
  } else {
    mapping.amountColumn = required(amountColumn, 'amount');
  }
  return mapping;
}

// ---------------------------------------------------------------------------------------------
// Household presets (table `import_preset`, unique per household and name)

export type ImportPreset = {
  id: string;
  name: string;
  kind: 'csv' | 'xlsx';
  mapping: ColumnMapping;
};

const presetInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(schema.IMPORT_PRESET_KINDS),
  mapping: columnMappingSchema,
});

function toPreset(row: typeof importPreset.$inferSelect): ImportPreset {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    mapping: columnMappingSchema.parse(row.mapping),
  };
}

export async function listPresetsInTx(tx: Tx, householdId: string): Promise<ImportPreset[]> {
  const rows = await tx
    .select()
    .from(importPreset)
    .where(eq(importPreset.householdId, householdId))
    .orderBy(asc(importPreset.name));
  return rows.map(toPreset);
}

export async function listImportPresets(ctx: ServiceCtx): Promise<ImportPreset[]> {
  return withHousehold(ctx.db, ctx.householdId, (tx) => listPresetsInTx(tx, ctx.householdId));
}

/** Creates the preset or, when the household already has one with this name, replaces its mapping. */
export async function savePresetInTx(
  tx: Tx,
  ctx: ServiceCtx,
  input: { name: string; kind: ImportPreset['kind']; mapping: ColumnMapping },
): Promise<void> {
  const value = parseInput(presetInput, input);
  await tx
    .insert(importPreset)
    .values({
      householdId: ctx.householdId,
      name: value.name,
      kind: value.kind,
      mapping: value.mapping,
      createdBy: ctx.userId,
    })
    .onConflictDoUpdate({
      target: [importPreset.householdId, importPreset.name],
      set: { kind: value.kind, mapping: value.mapping, updatedAt: new Date() },
    });
}

export async function saveImportPreset(
  ctx: ServiceCtx,
  input: { name: string; kind: ImportPreset['kind']; mapping: ColumnMapping },
): Promise<void> {
  assertCanWrite(ctx);
  await withHousehold(ctx.db, ctx.householdId, (tx) => savePresetInTx(tx, ctx, input));
}

export async function deleteImportPreset(ctx: ServiceCtx, id: string): Promise<void> {
  assertCanWrite(ctx);
  assertUuid(id, 'Import preset');
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const deleted = await tx
      .delete(importPreset)
      .where(and(eq(importPreset.id, id), eq(importPreset.householdId, ctx.householdId)))
      .returning({ id: importPreset.id });
    if (deleted.length === 0) throw new NotFoundError('Import preset');
  });
}

/**
 * A saved preset fits a table when its kind matches and all its columns exist in the header
 * line (at the preset's own header row, or else at the detected one). Returns the mapping to use.
 */
export function matchHouseholdPreset(
  table: ParsedTable,
  presets: ImportPreset[],
): { preset: ImportPreset; mapping: ColumnMapping } | null {
  if (table.kind === 'ofx') return null;
  for (const preset of presets) {
    if (preset.kind !== table.kind) continue;
    for (const headerRow of new Set([preset.mapping.headerRow, table.headerRow])) {
      const header = table.grid[headerRow]?.map(foldHeader);
      if (!header) continue;
      const m = preset.mapping;
      const names = [
        m.dateColumn,
        m.valueDateColumn,
        m.descriptionColumn,
        m.counterpartyColumn,
        m.amountColumn,
        m.debitColumn,
        m.creditColumn,
        m.feeColumn,
        m.currencyColumn,
        m.statusColumn,
        m.externalIdColumn,
        m.filterColumn?.column,
      ].filter((n): n is string => n !== undefined);
      if (names.every((n) => header.includes(foldHeader(n)))) {
        return { preset, mapping: { ...m, headerRow } };
      }
    }
  }
  return null;
}
