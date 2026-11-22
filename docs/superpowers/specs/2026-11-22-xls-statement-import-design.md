# Legacy Excel (.xls) statement import: design

## Intent

Some banks and card issuers only export statements as legacy Excel workbooks (`.xls`, BIFF8 inside an
OLE2 compound file). The import wizard rejects them today, so the user has to open the file in a
spreadsheet app and re-save it as `.xlsx`. The wizard should read `.xls` directly.

## Goals

- A `.xls` statement goes through the same four steps as `.xlsx`: upload, columns, preview, confirm.
- Files named `.xls` that are really something else (an XLSX archive, an HTML table, delimited text)
  are either read by the right parser or rejected with a clear message, never misparsed.
- The reader treats the file as hostile, with hard limits like the XLSX reader.

## Non-goals

- The budget import wizard (stays `.xlsx` only).
- Excel 95 and older (BIFF5 and below), password-protected workbooks, `.xlsb`, `.ods`.
- Evaluating formulas (only the cached result stored in the file is read), styles, merged cells.
- HTML tables saved as `.xls`: rejected with a message for now (no sample to build against).

## Anti-goals

- A new runtime dependency that parses untrusted uploads.
- A database migration.

## Approaches

1. **Hand-written minimal BIFF8 reader (chosen).** Reads the compound file and the handful of record
   types a statement uses. No dependency, every limit is ours, consistent with the XLSX path, which
   already distrusts its library enough to verify and rebuild the archive first. Cost: a few hundred
   lines and the edge cases are ours (strings split across `CONTINUE` records, date formats).
2. **SheetJS.** Reads everything, including BIFF5 and HTML. Rejected: the npm package is stale with
   known vulnerabilities, the maintained version installs only from the vendor's own CDN, and it is a
   large parser on untrusted input with no limits of its own.
3. **Reject with "save as .xlsx".** Nearly free, but leaves the work to every user on every import.

## Design

- **New `packages/services/src/import/xls.ts`** exporting `parseXls(buf): string[][]`, the same grid
  shape as `parseXlsx`.
  - Compound file: header check, 512 or 4096 byte sectors, FAT and DIFAT chains, directory, the
    `Workbook` (or `Book`) stream from the regular or the mini stream. Chains are bounded by the
    sector count and loops are rejected.
  - Workbook globals: `BOF` (must be BIFF8), `FILEPASS` (reject as protected), `DATEMODE`, `FORMAT`,
    `XF`, `BOUNDSHEET`, `SST` with `CONTINUE`.
  - First visible worksheet: `LABELSST`, `LABEL`, `NUMBER`, `RK`, `MULRK`, `FORMULA` with its
    `STRING`, `BOOLERR`. Blank records are ignored.
  - A number whose cell format is a date becomes `YYYY-MM-DD`; other numbers become plain text with a
    dot, exactly as the XLSX reader writes them.
  - Limits: `MAX_IMPORT_ROWS`, and the XLSX column, cell-count and cell-length limits (shared
    constants). Any structural error is a `ValidationError`, never a crash.
- **`parse-file.ts`**: `.xls` is accepted. The content decides the parser: OLE2 signature → `parseXls`;
  ZIP signature → `parseXlsx`; anything else under `.xls` → `ValidationError` asking to re-save as
  `.xlsx` or CSV.
- **Kind stays `'xlsx'`** for `.xls` tables. It means "spreadsheet grid whose numbers are plain
  dot-decimal text", which is what the amount rules and saved formats key on. No schema change, and a
  format saved from an `.xlsx` of the same bank fits its `.xls`. (My call.)
- **Web**: `.xls` added to the wizard's accepted extensions; the `accepts`, `badType` and
  `unsupported_type` strings mention XLS in all five locales; the error classifier maps the new
  messages to `invalid_file`.
- **Docs**: README, `docs/bank-sync.md`, `docs/architecture.md` list XLS.

## Testing

- A small fictional `.xls` fixture generated for the test suite (no real statement is committed),
  plus hand-built byte buffers for the edge cases: string split across `CONTINUE`, `RK`/`MULRK`
  decoding, date-formatted numbers, 1904 date system, mini-stream workbook, hidden first sheet,
  protected workbook, BIFF5, truncated file, looping sector chain, over-limit rows and columns.
- `parseFile` dispatch by content for the three `.xls` cases.
- One e2e step uploading the `.xls` fixture through the wizard to the preview.

## Left to the builder

How the fixture is produced, the internal structure of `xls.ts`, exact error wording.
