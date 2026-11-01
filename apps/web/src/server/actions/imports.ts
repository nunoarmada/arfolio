'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  commitImport,
  deleteImportPreset,
  getImportBatchSummary,
  MAX_IMPORT_BYTES,
  parseFile,
  previewImport,
  reviewCount,
  undoImport,
  ValidationError,
  type ColumnMapping,
  type ImportPreview,
} from '@arfolio/services';
import { getServiceCtx } from '../service-ctx';
import { run, validationReason, type ActionResult } from './result';

export interface PreviewRowDto {
  line: number;
  status: 'ok' | 'skipped' | 'error';
  reason?: string;
  error?: string;
  duplicate?: boolean;
  date?: string;
  description?: string;
  amount?: number;
  currency?: string;
  pending?: boolean;
}

export interface PreviewDto {
  presetKey: string | null;
  mapping: ColumnMapping | null;
  rows: PreviewRowDto[];
  stats: ImportPreview['stats'];
}

function toPreviewDto(p: ImportPreview): PreviewDto {
  return {
    presetKey: p.presetKey,
    mapping: p.mapping,
    stats: p.stats,
    rows: p.rows.map((r): PreviewRowDto => {
      if (r.status === 'ok') {
        return {
          line: r.line,
          status: 'ok',
          duplicate: r.duplicate === true,
          date: r.row.bookingDate,
          description: r.row.counterparty ?? r.row.description,
          amount: r.row.amount,
          currency: r.row.currency,
          pending: r.row.status === 'pending',
        };
      }
      if (r.status === 'skipped') return { line: r.line, status: 'skipped', reason: r.reason };
      return { line: r.line, status: 'error', error: r.error };
    }),
  };
}

/** What the mapping step needs to show: the file's columns and a few sample rows. */
export interface FileInfoDto {
  kind: 'csv' | 'xlsx' | 'ofx';
  headers: string[];
  headerRow: number;
  samples: string[][];
}

export interface AnalysisDto {
  file: FileInfoDto;
  /** Null when the layout is not recognised: the user maps the columns by hand. */
  preview: PreviewDto | null;
}

const SAMPLE_ROWS = 3;

async function readUpload(form: FormData): Promise<{ buffer: Buffer; filename: string }> {
  const file = form.get('file');
  if (!(file instanceof File)) throw new ValidationError('The file is empty');
  // A cheap early check (Next has already buffered the form, bounded by bodySizeLimit); the
  // services check the size again on the bytes they parse.
  if (file.size > MAX_IMPORT_BYTES)
    throw new ValidationError('The file is too large (maximum 10 MB)');
  return { buffer: Buffer.from(await file.arrayBuffer()), filename: file.name };
}

function mappingOf(form: FormData): ColumnMapping | undefined {
  const raw = form.get('mapping');
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    return JSON.parse(raw) as ColumnMapping;
  } catch {
    throw new ValidationError('Invalid mapping');
  }
}

function accountOf(form: FormData): string {
  const id = form.get('accountId');
  return typeof id === 'string' ? id : '';
}

/** Reads the file, detects a layout and previews it (or, when the layout is unknown, only reads it). */
export async function analyseImportAction(form: FormData): Promise<ActionResult<AnalysisDto>> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    const file = await readUpload(form);
    const table = await parseFile(file.buffer, file.filename);
    const info: FileInfoDto = {
      kind: table.kind,
      headers: table.headers,
      headerRow: table.headerRow,
      samples: table.rows.filter((r) => r.some((c) => c.trim() !== '')).slice(0, SAMPLE_ROWS),
    };
    try {
      const preview = await previewImport(ctx, { accountId: accountOf(form), file });
      return { file: info, preview: toPreviewDto(preview) };
    } catch (error) {
      if (
        error instanceof ValidationError &&
        validationReason(error.message) === 'unrecognised_layout'
      ) {
        return { file: info, preview: null };
      }
      throw error;
    }
  });
}

export async function previewImportAction(form: FormData): Promise<ActionResult<PreviewDto>> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    const file = await readUpload(form);
    const mapping = mappingOf(form);
    return toPreviewDto(
      await previewImport(ctx, {
        accountId: accountOf(form),
        file,
        ...(mapping ? { mapping } : {}),
      }),
    );
  });
}

export interface CommitDto {
  batchId: string;
  inserted: number;
  duplicates: number;
  skipped: number;
  errors: number;
  /** Rows waiting in the review inbox after the import (household-wide). */
  reviewCount: number;
}

export async function commitImportAction(form: FormData): Promise<ActionResult<CommitDto>> {
  return run(async () => {
    const ctx = await getServiceCtx(await headers());
    const file = await readUpload(form);
    const mapping = mappingOf(form);
    const presetName = form.get('presetName');
    const result = await commitImport(ctx, {
      accountId: accountOf(form),
      file,
      ...(mapping ? { mapping } : {}),
      ...(typeof presetName === 'string' && presetName.trim() !== ''
        ? { saveAsPreset: { name: presetName } }
        : {}),
    });
    revalidatePath('/', 'layout');
    return {
      batchId: result.batchId,
      inserted: result.inserted,
      duplicates: result.duplicates,
      skipped: result.skipped,
      errors: result.errors,
      reviewCount: await reviewCount(ctx),
    };
  });
}

export async function getBatchSummaryAction(
  batchId: string,
): Promise<ActionResult<{ rows: number; editedRows: number; undone: boolean }>> {
  return run(async () => {
    const s = await getImportBatchSummary(await getServiceCtx(await headers()), batchId);
    return { rows: s.rows, editedRows: s.editedRows, undone: s.undoneAt !== null };
  });
}

export async function undoImportAction(
  batchId: string,
): Promise<ActionResult<{ deleted: number; editedRows: number }>> {
  return run(async () => {
    const result = await undoImport(await getServiceCtx(await headers()), batchId);
    revalidatePath('/', 'layout');
    return result;
  });
}

export async function deletePresetAction(id: string): Promise<ActionResult> {
  return run(async () => {
    await deleteImportPreset(await getServiceCtx(await headers()), id);
    revalidatePath('/settings/import');
    return null;
  });
}
