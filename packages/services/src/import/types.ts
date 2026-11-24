import type { IngestRow } from '../pipeline.js';

/** Untrusted-input limits for statement files. */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
/** Counts every line of the file, including title rows and the header. */
export const MAX_IMPORT_ROWS = 50_000;

export type TableKind = 'csv' | 'xlsx' | 'ofx';

/** One input row after mapping (or OFX normalisation). `line` is the 1-based line/row in the file. */
export type ParsedRow =
  | { line: number; status: 'ok'; row: IngestRow }
  | { line: number; status: 'skipped'; reason: 'empty' | 'summary' | 'filtered' }
  | { line: number; status: 'error'; error: string };

/** The leaf tags of one `<STMTTRN>` (first value of each, entities decoded), by upper-case name. */
export type OfxTransaction = { line: number; tags: Record<string, string> };

/**
 * An OFX statement as read from the file. Amounts stay text until the account is known: their
 * minor units depend on its currency (`ofxRows` in ofx.ts).
 */
export type OfxParse = {
  /** Statement currency (`CURDEF`), when present. */
  currency?: string;
  transactions: OfxTransaction[];
};

/**
 * A statement file read into plain strings. CSV and XLSX give a `grid` (every line, including
 * title rows and footers), the detected header line and the data lines below it; OFX gives its
 * transactions in `ofx` (its `grid` is empty).
 */
export type ParsedTable = {
  kind: TableKind;
  grid: string[][];
  headerRow: number;
  headers: string[];
  rows: string[][];
  ofx?: OfxParse;
};
