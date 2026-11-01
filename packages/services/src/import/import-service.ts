import { basename } from 'node:path';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
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
  chunks,
  ID_CHUNK,
  ingestRowsInTx,
  keyRowsForDedupe,
  rekeyCollidingExternalRows,
  lockAccountIngest,
  type IngestResult,
  type IngestRow,
} from '../pipeline.js';
import { lockTransfers, unlinkGroupInTx } from '../transactions.js';
import { applyMapping, columnMappingSchema, type ColumnMapping } from './mapping.js';
import { parseFile } from './parse-file.js';
import {
  detectPreset,
  listPresetsInTx,
  matchHouseholdPreset,
  presetMapping,
  savePresetInTx,
} from './presets.js';
import type { ParsedRow, ParsedTable } from './types.js';

const { financialAccount, importBatch, transaction } = schema;

const PREVIEW_ROWS = 50;
const MAX_FILENAME = 255;

const fileSchema = z.strictObject({
  buffer: z.instanceof(Buffer),
  filename: z.string().min(1).max(1_000),
});
const previewSchema = z.strictObject({
  accountId: z.string(),
  file: fileSchema,
  mapping: columnMappingSchema.optional(),
});
const commitSchema = z.strictObject({
  accountId: z.string(),
  file: fileSchema,
  mapping: columnMappingSchema.optional(),
  saveAsPreset: z.strictObject({ name: z.string().trim().min(1).max(100) }).optional(),
});

export type ImportFile = z.input<typeof fileSchema>;
export type PreviewImportInput = z.input<typeof previewSchema>;
export type CommitImportInput = z.input<typeof commitSchema>;
export type PreviewRow = ParsedRow & { duplicate?: boolean };
export type ImportStats = {
  total: number;
  valid: number;
  skipped: number;
  /** Rows that could not be read (bad date or amount, ...); they are not imported. */
  errors: number;
  duplicates: number;
};
export type ImportPreview = {
  /** A built-in key, `household:<name>` for a saved preset, or null (OFX, or a mapping given by the caller). */
  presetKey: string | null;
  /** The mapping in use; null for OFX, which needs none. */
  mapping: ColumnMapping | null;
  rows: PreviewRow[];
  stats: ImportStats;
};
export type CommitImportResult = IngestResult & {
  batchId: string;
  skipped: number;
  errors: number;
};

type Prepared = {
  account: typeof financialAccount.$inferSelect;
  table: ParsedTable;
  presetKey: string | null;
  mapping: ColumnMapping | null;
  parsed: ParsedRow[];
};

async function requireAccount(tx: Tx, ctx: ServiceCtx, accountId: string) {
  assertUuid(accountId, 'Account');
  const [account] = await tx
    .select()
    .from(financialAccount)
    .where(
      and(eq(financialAccount.id, accountId), eq(financialAccount.householdId, ctx.householdId)),
    );
  if (!account) throw new NotFoundError('Account');
  return account;
}

/** Applies the mapping in use (given, a household preset, or a built-in one) to the file. */
async function prepare(
  tx: Tx,
  ctx: ServiceCtx,
  table: ParsedTable,
  accountId: string,
  given: ColumnMapping | undefined,
): Promise<Prepared> {
  const account = await requireAccount(tx, ctx, accountId);
  if (table.kind === 'ofx') {
    const ofx = table.ofx!;
    if (ofx.currency && ofx.currency !== account.currency) {
      throw new ValidationError(
        `The statement is in ${ofx.currency} but the account is in ${account.currency}`,
      );
    }
    const parsed = ofx.rows.map((r) =>
      r.status === 'ok' ? { ...r, row: { ...r.row, currency: account.currency } } : r,
    );
    return { account, table, presetKey: null, mapping: null, parsed };
  }

  let mapping = given;
  let presetKey: string | null = null;
  if (!mapping) {
    const household = matchHouseholdPreset(table, await listPresetsInTx(tx, ctx.householdId));
    if (household) {
      mapping = household.mapping;
      presetKey = `household:${household.preset.name}`;
    } else {
      const builtin = detectPreset(table);
      if (!builtin) {
        throw new ValidationError(
          'Could not recognise the file layout: choose which columns hold the date, description and amount',
        );
      }
      mapping = presetMapping(builtin, table);
      presetKey = builtin;
    }
  }
  const parsed = applyMapping(table, mapping, { currency: account.currency });
  return { account, table, presetKey, mapping, parsed };
}

function countOutcomes(parsed: ParsedRow[]): Omit<ImportStats, 'duplicates'> {
  let valid = 0;
  let skipped = 0;
  let errors = 0;
  for (const r of parsed) {
    if (r.status === 'ok') valid += 1;
    else if (r.status === 'skipped') skipped += 1;
    else errors += 1;
  }
  return { total: parsed.length, valid, skipped, errors };
}

/**
 * Which of `rows` the ingest would treat as already present, without writing, following the
 * same rules in the same order: a booked row replaces a pending row with its external id, or
 * (neither having an external id) with the same dedupe hash; anything else sharing an external
 * id or hash with an existing row is a duplicate, and so is a second row in the file with an
 * external id already used earlier in the file.
 */
async function findDuplicates(
  tx: Tx,
  householdId: string,
  accountId: string,
  rows: IngestRow[],
): Promise<Set<number>> {
  // The same re-keying as the ingest, so the preview counts what the commit will skip.
  const keyed = await rekeyCollidingExternalRows(
    tx,
    householdId,
    accountId,
    keyRowsForDedupe(accountId, rows),
  );
  const scope = and(eq(transaction.householdId, householdId), eq(transaction.accountId, accountId));

  const byHash = new Map<string, { status: string; hasExternalId: boolean }>();
  for (const part of chunks([...new Set(keyed.map((k) => k.dedupeHash))], ID_CHUNK)) {
    const found = await tx
      .select({
        hash: transaction.dedupeHash,
        status: transaction.status,
        externalId: transaction.externalId,
      })
      .from(transaction)
      .where(and(scope, inArray(transaction.dedupeHash, part)));
    for (const f of found) {
      byHash.set(f.hash, { status: f.status, hasExternalId: f.externalId !== null });
    }
  }
  const byExternalId = new Map<string, string>();
  const ids = [...new Set(keyed.flatMap((k) => (k.externalId ? [k.externalId] : [])))];
  for (const part of chunks(ids, ID_CHUNK)) {
    const found = await tx
      .select({ externalId: transaction.externalId, status: transaction.status })
      .from(transaction)
      .where(and(scope, inArray(transaction.externalId, part)));
    for (const f of found) byExternalId.set(f.externalId!, f.status);
  }

  const duplicates = new Set<number>();
  const seenExternalIds = new Set<string>();
  keyed.forEach((k, i) => {
    const booked = k.status === 'booked';
    if (k.externalId) {
      if (seenExternalIds.has(k.externalId)) return void duplicates.add(i);
      seenExternalIds.add(k.externalId);
      const existing = byExternalId.get(k.externalId);
      if (existing !== undefined) {
        if (!(existing === 'pending' && booked)) duplicates.add(i);
        return;
      }
      if (byHash.has(k.dedupeHash)) duplicates.add(i);
      return;
    }
    const existing = byHash.get(k.dedupeHash);
    if (!existing) return;
    const replacesPending = booked && existing.status === 'pending' && !existing.hasExternalId;
    if (!replacesPending) duplicates.add(i);
  });
  return duplicates;
}

/**
 * Reads the file and shows what importing it would do: the detected (or given) mapping, the
 * first 50 lines parsed or with their error, and counts including rows already in the account.
 * Writes nothing.
 */
export async function previewImport(
  ctx: ServiceCtx,
  rawInput: PreviewImportInput,
): Promise<ImportPreview> {
  assertCanWrite(ctx);
  const input = parseInput(previewSchema, rawInput);
  const table = await parseFile(input.file.buffer, input.file.filename);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const { account, presetKey, mapping, parsed } = await prepare(
      tx,
      ctx,
      table,
      input.accountId,
      input.mapping,
    );
    const okRows = parsed.flatMap((r) => (r.status === 'ok' ? [r.row] : []));
    const duplicates = await findDuplicates(tx, ctx.householdId, account.id, okRows);
    let okIndex = 0;
    const flagged: PreviewRow[] = parsed.map((r) =>
      r.status === 'ok' ? { ...r, duplicate: duplicates.has(okIndex++) } : r,
    );
    return {
      presetKey,
      mapping,
      rows: flagged.slice(0, PREVIEW_ROWS),
      stats: { ...countOutcomes(parsed), duplicates: duplicates.size },
    };
  });
}

/**
 * Imports the file into the account as one batch (undoable with undoImport). Rows that are
 * skipped or cannot be read are not imported; both are counted (`skipped`, `errors`) and stored
 * as the batch's skipped rows. The batch and its rows are created in one transaction. With
 * `saveAsPreset` the mapping is saved as a household preset under that name.
 */
export async function commitImport(
  ctx: ServiceCtx,
  rawInput: CommitImportInput,
): Promise<CommitImportResult> {
  assertCanWrite(ctx);
  const input = parseInput(commitSchema, rawInput);
  const table = await parseFile(input.file.buffer, input.file.filename);
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    // Same order as ingest: account lock first.
    assertUuid(input.accountId, 'Account');
    await lockAccountIngest(tx, input.accountId);
    const { account, presetKey, mapping, parsed } = await prepare(
      tx,
      ctx,
      table,
      input.accountId,
      input.mapping,
    );
    if (account.archivedAt) throw new ValidationError('Account is archived');
    const counts = countOutcomes(parsed);
    if (counts.valid === 0) throw new ValidationError('The file has no rows to import');
    if (input.saveAsPreset && (!mapping || table.kind === 'ofx')) {
      throw new ValidationError(
        'OFX files need no mapping, so there is nothing to save as a preset',
      );
    }

    const [batch] = await tx
      .insert(importBatch)
      .values({
        householdId: ctx.householdId,
        accountId: account.id,
        source: table.kind,
        filename: basename(input.file.filename).slice(0, MAX_FILENAME),
        presetKey,
        rowsTotal: counts.total,
        createdBy: ctx.userId,
      })
      .returning({ id: importBatch.id });
    const okRows = parsed.flatMap((r) => (r.status === 'ok' ? [r.row] : []));
    const result = await ingestRowsInTx(tx, ctx, account.id, okRows, {
      source: 'import',
      importBatchId: batch!.id,
    });
    await tx
      .update(importBatch)
      .set({
        rowsImported: result.inserted,
        rowsDuplicate: result.duplicates,
        rowsSkipped: counts.skipped + counts.errors,
      })
      .where(eq(importBatch.id, batch!.id));
    if (input.saveAsPreset && mapping && table.kind !== 'ofx') {
      await savePresetInTx(tx, ctx, { name: input.saveAsPreset.name, kind: table.kind, mapping });
    }
    return { ...result, batchId: batch!.id, skipped: counts.skipped, errors: counts.errors };
  });
}

export type ImportBatchRow = typeof importBatch.$inferSelect;

/** Import batches, newest first (undone ones included: `undoneAt` tells). Read-only. */
export async function listImportBatches(
  ctx: ServiceCtx,
  opts: { accountId?: string; limit?: number } = {},
): Promise<ImportBatchRow[]> {
  const { accountId } = opts;
  if (accountId !== undefined) assertUuid(accountId, 'Account');
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20), 1), 100);
  return withHousehold(ctx.db, ctx.householdId, (tx) =>
    tx
      .select()
      .from(importBatch)
      .where(
        and(
          eq(importBatch.householdId, ctx.householdId),
          accountId ? eq(importBatch.accountId, accountId) : undefined,
        ),
      )
      .orderBy(desc(importBatch.createdAt), desc(importBatch.id))
      .limit(limit),
  );
}

/** What undoing a batch would delete, so the caller can warn first. Read-only. */
export async function getImportBatchSummary(
  ctx: ServiceCtx,
  batchId: string,
): Promise<{ rows: number; editedRows: number; undoneAt: Date | null }> {
  assertUuid(batchId, 'Import batch');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [batch] = await tx
      .select({ undoneAt: importBatch.undoneAt })
      .from(importBatch)
      .where(and(eq(importBatch.id, batchId), eq(importBatch.householdId, ctx.householdId)));
    if (!batch) throw new NotFoundError('Import batch');
    const [counts] = await tx
      .select({
        rows: sql<number>`count(*)::int`,
        edited: sql<number>`count(*) filter (where ${transaction.userEditedAt} is not null)::int`,
      })
      .from(transaction)
      .where(
        and(eq(transaction.householdId, ctx.householdId), eq(transaction.importBatchId, batchId)),
      );
    return { rows: counts!.rows, editedRows: counts!.edited, undoneAt: batch.undoneAt };
  });
}

/**
 * Deletes the rows of one import batch and marks the batch undone. Transfers the rows were part
 * of are dissolved: the other leg becomes uncategorised and returns to the review inbox (and may
 * pair again later). A pending row that this batch replaced by its booked version belongs to the
 * batch too and is deleted with it. `editedRows` counts deleted rows the user had edited, so the caller can warn.
 */
export async function undoImport(
  ctx: ServiceCtx,
  batchId: string,
): Promise<{ deleted: number; editedRows: number }> {
  assertCanWrite(ctx);
  assertUuid(batchId, 'Import batch');
  return withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const [found] = await tx
      .select()
      .from(importBatch)
      .where(and(eq(importBatch.id, batchId), eq(importBatch.householdId, ctx.householdId)));
    if (!found) throw new NotFoundError('Import batch');
    // Lock order: account -> transfers -> rows.
    await lockAccountIngest(tx, found.accountId);
    await lockTransfers(tx, ctx.householdId);
    const [batch] = await tx
      .select()
      .from(importBatch)
      .where(eq(importBatch.id, batchId))
      .for('update');
    if (batch!.undoneAt) throw new ValidationError('This import was already undone');

    const inBatch = and(
      eq(transaction.householdId, ctx.householdId),
      eq(transaction.importBatchId, batchId),
    );
    const groups = await tx
      .selectDistinct({ id: transaction.transferGroupId })
      .from(transaction)
      .where(and(inBatch, isNotNull(transaction.transferGroupId)));
    for (const g of groups) {
      await unlinkGroupInTx(tx, ctx.householdId, g.id!, { byUser: false });
    }
    const [edited] = await tx
      .select({
        n: sql<number>`count(*) filter (where ${transaction.userEditedAt} is not null)::int`,
      })
      .from(transaction)
      .where(inBatch);
    const deleted = await tx.delete(transaction).where(inBatch).returning({ id: transaction.id });
    await tx.update(importBatch).set({ undoneAt: new Date() }).where(eq(importBatch.id, batchId));
    return { deleted: deleted.length, editedRows: edited!.n };
  });
}
