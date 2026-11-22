# Legacy Excel (.xls) Statement Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The statement import wizard reads legacy Excel workbooks (`.xls`, BIFF8) directly.

**Architecture:** A hand-written reader in `packages/services/src/import/xls.ts` turns the upload into the same `string[][]` grid `parseXlsx` returns. `parseFile` accepts `.xls` and picks the parser from the file's signature, reporting the table as kind `'xlsx'` so mapping, saved formats and the database are untouched. The web wizard only widens its accepted extensions and copy.

**Tech Stack:** TypeScript, Node `Buffer`, vitest, Playwright. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-22-xls-statement-import-design.md`

## Global Constraints

- No new runtime dependency; no database migration.
- The file is untrusted: every offset is bounds-checked, every chain is bounded, every failure is a `ValidationError` (from `../context.js`), never another exception.
- Limits reused from existing constants: `MAX_IMPORT_ROWS` (`types.ts`), `MAX_XLSX_COLUMNS`, `MAX_XLSX_CELLS`, `MAX_XLSX_CELL_CHARS` (`xlsx.ts`), with the same error messages the XLSX reader uses for them.
- No personal data: fixtures and tests use fictional names ("Grocer Example") only. The user's real statement is never copied into the repository.
- UI strings change in all five locale files with identical placeholders.
- Conventional Commits, signed off (`git commit -s`).

## Review Focus

1. A text cell split across `SST`/`CONTINUE` records, including a switch between 8-bit and 16-bit encoding at the boundary: the full string is returned. (Task 2)
2. A date stored as a number with a date format (built-in or custom): `YYYY-MM-DD`, not a serial number; a custom format whose only `d`/`m`/`y` letters are inside quotes or brackets is not a date. (Task 2)
3. A workbook small enough to live in the compound file's mini stream: read like any other. (Task 1)
4. A file whose sector chain loops or points outside the file: rejected quickly, no hang. (Task 1)
5. A `.xls` name on a file that is really an XLSX archive: read by the XLSX reader. (Task 3)

---

### Task 1: Compound file container

**Files:**
- Create: `packages/services/src/import/xls.ts`
- Create: `packages/services/test/import/xls-builder.ts`
- Test: `packages/services/test/import/xls.test.ts`

**Interfaces:**
- Produces (source): `export function readWorkbookStream(buf: Buffer): Buffer` — the bytes of the `Workbook` stream (fallback name `Book`), case-insensitive, of a compound file.
- Produces (test helper): `export function buildCfb(stream: Buffer, opts?: { name?: string; mini?: boolean }): Buffer` — a minimal valid compound file (512-byte sectors, one FAT chain, root entry + one stream; `mini: true` stores the stream in the mini stream and requires `stream.length < 4096`).

- [ ] **Step 1: Write the failing tests** in `xls.test.ts`, `describe('readWorkbookStream')`:
  - `returns the Workbook stream of a regular compound file`: `readWorkbookStream(buildCfb(payload))` equals a 5000-byte patterned `payload`.
  - `reads a workbook stored in the mini stream`: same with a 300-byte payload and `{ mini: true }`.
  - `accepts the legacy stream name Book`.
  - `rejects a file without the compound signature`, `a truncated file` (valid file sliced to 600 bytes), `a looping sector chain` (patch the FAT so the stream's first sector points to itself), `a chain pointing outside the file`, `a compound file without a workbook stream` (`{ name: 'Other' }`): each `toThrow(ValidationError)` with message `The file is not a valid XLS workbook`.
- [ ] **Step 2: Run** `pnpm vitest run packages/services/test/import/xls.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement `readWorkbookStream`.** Header: signature `D0 CF 11 E0 A1 B1 1A E1`, sector shift 9 or 12, mini sector shift 6, mini cutoff from the header. FAT sectors from the 109 header DIFAT slots plus the DIFAT chain. Every chain walk stops with an error after more sectors than the file holds. Directory entries are 128 bytes; type 2 = stream, type 5 = root (its chain is the mini stream container). A stream smaller than the cutoff is read through the mini FAT. The result is sliced to the directory's declared size, which must not exceed the chain.
- [ ] **Step 4: Run** the same command — PASS.
- [ ] **Step 5: Commit** `feat(import): read the workbook stream of legacy Excel files`.

### Task 2: BIFF8 records to grid

**Files:**
- Modify: `packages/services/src/import/xls.ts`
- Modify: `packages/services/test/import/xls-builder.ts`
- Test: `packages/services/test/import/xls.test.ts`

**Interfaces:**
- Consumes: `readWorkbookStream`, `buildCfb`.
- Produces (source): `export function parseXls(buf: Buffer): string[][]` — first visible worksheet; rows as long as their last real cell, gaps `''`; empty sheet throws `The spreadsheet is empty`.
- Produces (test helper): `export function rec(type: number, data: Buffer): Buffer` (one BIFF record), and `export function buildXls(sheets: Array<{ name?: string; hidden?: boolean; rows: Array<Array<XlsCell>> }>, opts?: { date1904?: boolean; biffVersion?: number; filepass?: boolean; extraGlobals?: Buffer; sstChunk?: number }): Buffer` where `type XlsCell = string | number | null | { date: number; format?: string } | { rk: number } | { formula: number | string } | { bool: boolean } | { label: string }`. Strings go through the SST (`sstChunk` forces a `CONTINUE` split every N bytes of string data); numbers are `NUMBER` records; `{ rk }` writes an `RK`; `{ date }` writes a `NUMBER` with an XF whose format is built-in 14, or a custom `FORMAT` when `format` is given.

- [ ] **Step 1: Write the failing tests**, `describe('parseXls')`:
  - `reads text and numbers as plain strings`: rows `[['Date','Description','Amount'], ['02/03/2026','Grocer Example',-23.45], ['03/03/2026','Salary Example Corp',1500]]` → `[['Date','Description','Amount'], ['02/03/2026','Grocer Example','-23.45'], ['03/03/2026','Salary Example Corp','1500']]`.
  - `keeps non-ASCII text`: `'Café Açúcar €'` round-trips.
  - `joins strings split across CONTINUE records` (`sstChunk: 7`, 8-bit and 16-bit strings).
  - `decodes RK numbers`: integer RK `1500`, integer ÷100 RK `-23.45`, float RK `0.5` → `'1500'`, `'-23.45'`, `'0.5'`; and adjacent RK cells written as one `MULRK`.
  - `turns date-formatted numbers into ISO dates`: `{ date: 46083 }` → `'2026-03-02'`; `{ date: 46083, format: 'dd/mm/yyyy' }` → `'2026-03-02'`; `{ date: 46083.75 }` → `'2026-03-02'`; with `date1904: true`, `{ date: 44621 }` → `'2026-03-02'`.
  - `does not treat quoted letters as a date format`: `{ date: 12.5, format: '0.00" dias"' }` → `'12.5'`.
  - `reads the cached result of a formula, never the formula`: `{ formula: 7 }` → `'7'`; `{ formula: 'text result' }` → `'text result'`.
  - `reads booleans and legacy inline labels`: `{ bool: true }` → `'TRUE'`; `{ label: 'Old' }` → `'Old'`.
  - `leaves blank cells empty and pads gaps`: `['a', null, 'c']` → `['a', '', 'c']`; an empty row between two rows is `[]`.
  - `skips hidden sheets`: first sheet hidden, second visible → second sheet's rows.
  - Rejections, each `ValidationError`: `filepass: true` → `The workbook is password-protected`; `biffVersion: 0x0500` → `Excel 95 and older workbooks are not supported`; all sheets hidden → `The workbook has no visible worksheet`; a sheet with no cells → `The spreadsheet is empty`; a cell in row index `MAX_IMPORT_ROWS` → `/too many rows/`; a cell in column index `MAX_XLSX_COLUMNS` → `/too many columns/`; a string longer than `MAX_XLSX_CELL_CHARS` → `/too much text/`; a record whose declared length runs past the stream → `The file is not a valid XLS workbook`; an `SST` index beyond the table → same.
- [ ] **Step 2: Run** `pnpm vitest run packages/services/test/import/xls.test.ts` — the new tests FAIL.
- [ ] **Step 3: Implement `parseXls`.** Records are `type(u16) length(u16) data`. Globals substream (first `BOF`, version must be `0x0600`, else the Excel 95 error): `FILEPASS 0x2F`, `DATEMODE 0x22`, `FORMAT 0x41E`, `XF 0xE0` (format index at offset 2), `BOUNDSHEET 0x85` (stream offset u32, visibility at 4 with low two bits ≠ 0 hidden, type at 5 must be 0 = worksheet), `SST 0xFC` followed by `CONTINUE 0x3C`. Unicode strings: char count, flags byte (bit 0 16-bit, bit 2 phonetic, bit 3 rich text), optional run count and phonetic size, then characters; when the characters cross into a `CONTINUE`, that record starts with a fresh flags byte for the remainder. Sheet substream at the first visible worksheet's offset until `EOF 0x0A`: `LABELSST 0xFD`, `LABEL 0x204`, `NUMBER 0x203`, `RK 0x27E`, `MULRK 0xBD`, `FORMULA 0x06` (result bytes 6..13: a double, unless bytes 12-13 are `0xFFFF`, in which case byte 6 selects string from the following `STRING 0x207` record, boolean, error = `''`, or empty), `BOOLERR 0x205`. Everything else is skipped. Numbers print as `String(Number(value.toPrecision(15)))`, non-finite as `''`. A numeric cell is a date when its XF's format index is 14-22, 27-36, 45-47 or 50-58, or names a custom format that, after removing quoted text, bracketed sections and backslash-escaped characters, contains `d`, `m`, `y`, `h` or `s` (case-insensitive). Serial to date: days since 1899-12-30 (1904-01-01 when `DATEMODE` is 1), UTC, date part only; a serial outside 0..2958465 prints as a number.
- [ ] **Step 4: Run** the same command — PASS.
- [ ] **Step 5: Commit** `feat(import): parse BIFF8 worksheets into an import grid`.

### Task 3: Dispatch in `parseFile` and fixture

**Files:**
- Modify: `packages/services/src/import/parse-file.ts`
- Create: `packages/services/test/fixtures/import/statement.xls` (written once from `buildXls`)
- Test: `packages/services/test/import/parsers.test.ts`

**Interfaces:**
- Consumes: `parseXls(buf: Buffer): string[][]`, `buildXls`.
- Produces: `parseFile(buf, 'x.xls')` resolves to a `ParsedTable` with `kind: 'xlsx'`.

- [ ] **Step 1: Generate the fixture** with a one-off `tsx` command calling `buildXls` with the same content as `statement.xlsx`: three title rows (`['Example Bank'], ['Statement 2026-03'], []`), header `['Date','Description','Amount','Balance']`, rows `[{date:46083},'Grocer Example',-23.45,1976.55]`, `[{date:46084},'Salary Example Corp',1500,3476.55]`, `[{date:46086},'Rent Example',-1234.56,2241.99]`, two blank/notes rows as in the XLSX fixture, footer `['Total', null, 241.99]`. Check `statement.xlsx`'s actual rows first and mirror them so the e2e counts (3 new, 2 skipped, 0 errors) hold.
- [ ] **Step 2: Write the failing tests**, `describe('parseFile: xls')`:
  - `reads a legacy workbook like its XLSX twin`: `kind` `'xlsx'`, `headerRow` 3, `headers` `['Date','Description','Amount','Balance']`, `rows.slice(0,3)` equal to the three rows of the XLSX test above, footer first cell `'Total'`.
  - `reads an XLSX archive that was named .xls`: `parseFile(fixture('statement.xlsx'), 'statement.xls')` has the same headers.
  - `rejects text or HTML named .xls`: `Buffer.from('<html><table><tr><td>x</td></tr></table></html>')` → `ValidationError` `The file is not a valid XLS workbook: save it as .xlsx or CSV`.
  - `applies the size limit before parsing` for `.xls` (reuse the existing oversize pattern).
  - Change the existing unsupported-type expectation to `Unsupported file type: use CSV, OFX, XLS or XLSX`.
- [ ] **Step 3: Run** `pnpm vitest run packages/services/test/import/parsers.test.ts` — the new tests FAIL.
- [ ] **Step 4: Implement.** Add `'.xls': 'xlsx'` to `KINDS`. For a `.xls` name: first 8 bytes equal the compound signature → `parseXls`; first 4 bytes `50 4B 03 04` → `parseXlsx`; else the error above. `.xlsx` names keep going straight to `parseXlsx`. Update the unsupported-type message and the doc comment.
- [ ] **Step 5: Run** `pnpm vitest run packages/services/test/import` — PASS.
- [ ] **Step 6: Commit** `feat(import): accept legacy Excel statements`.

### Task 4: Web wizard, copy and docs

**Files:**
- Modify: `apps/web/src/components/import/import-wizard.tsx:34`
- Modify: `apps/web/src/server/actions/result.ts` (REASONS), `apps/web/src/server/actions/result.test.ts`
- Modify: `apps/web/messages/{en,pt-PT,es-ES,fr-FR,it-IT}.json` (`actionErrors.reason.unsupported_type`, import `upload.accepts`, `upload.badType`)
- Modify: `apps/web/e2e/phase1.spec.ts`
- Modify: `README.md:20`, `docs/bank-sync.md:91`, `docs/architecture.md:54`

**Interfaces:**
- Consumes: the error messages of Tasks 2 and 3.

- [ ] **Step 1: Write the failing tests.** In `result.test.ts` add to the `validationReason` table: `['Unsupported file type: use CSV, OFX, XLS or XLSX', 'unsupported_type']`, `['The file is not a valid XLS workbook', 'invalid_file']`, `['The file is not a valid XLS workbook: save it as .xlsx or CSV', 'invalid_file']`, `['The workbook is password-protected', 'invalid_file']`, `['Excel 95 and older workbooks are not supported', 'invalid_file']`. In `phase1.spec.ts`, next to the XLSX test, add `a legacy XLS statement is read by the server and previewed` with the same steps and expectations against `statement.xls`.
- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/server/actions/result.test.ts` — the new rows FAIL.
- [ ] **Step 3: Implement.** `ACCEPT = '.csv,.tsv,.txt,.xlsx,.xls,.ofx,.qfx'`. `invalid_file` pattern gains `not a valid xls`, `password-protected`, `are not supported`. Copy: `accepts` lists `.csv, .xlsx, .xls and .ofx`; `badType` and `unsupported_type` list `CSV, XLSX, XLS or OFX` (each locale's own conjunction). Docs: "CSV, XLSX, XLS and OFX".
- [ ] **Step 4: Run** `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` — PASS. Run the phase1 e2e spec if the environment can start the app; otherwise say so.
- [ ] **Step 5: Commit** `feat(import): offer .xls in the statement import wizard`.
