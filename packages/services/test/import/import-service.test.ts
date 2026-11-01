import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withHousehold } from '@arfolio/db';
import {
  archiveAccount,
  commitImport,
  deleteImportPreset,
  getImportBatchSummary,
  createAccount,
  createManualTransaction,
  ForbiddenError,
  getTransaction,
  ingestTransactions,
  listImportBatches,
  listImportPresets,
  markTransfer,
  NotFoundError,
  previewImport,
  seedCategoryTemplates,
  undoImport,
  updateTransaction,
  ValidationError,
  type ColumnMapping,
  type ServiceCtx,
} from '../../src/index.js';
import { startServicesDb, withRole, type ServicesTestDb } from '../helpers.js';

const fixtureBuf = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/import/${name}`, import.meta.url)));
const file = (name: string, filename = name) => ({ buffer: fixtureBuf(name), filename });
const csvFile = (text: string, filename = 'x.csv') => ({
  buffer: Buffer.from(text, 'utf8'),
  filename,
});

describe('file import', () => {
  let t: ServicesTestDb;
  let a: ServiceCtx;
  let b: ServiceCtx;

  const rowsOf = (ctx: ServiceCtx, accountId: string) =>
    withHousehold(ctx.db, ctx.householdId, (tx) =>
      tx.select().from(schema.transaction).where(eq(schema.transaction.accountId, accountId)),
    );
  const account = async (ctx = a, currency = 'EUR') =>
    (await createAccount(ctx, { name: 'Acc', type: 'checking', currency })).id;

  beforeAll(async () => {
    t = await startServicesDb();
    a = await t.household({ locale: 'en' });
    b = await t.household();
    await seedCategoryTemplates(a, 'en');
  });
  afterAll(() => t.close());

  describe('previewImport', () => {
    it('detects the preset, parses the first rows and counts without writing', async () => {
      const acc = await account();
      const preview = await previewImport(a, { accountId: acc, file: file('pt-bank-latin1.csv') });
      expect(preview.presetKey).toBe('pt_bank');
      expect(preview.mapping).toMatchObject({ dateColumn: 'Data Mov.', headerRow: 4 });
      expect(preview.stats).toEqual({ total: 7, valid: 5, skipped: 2, errors: 0, duplicates: 0 });
      expect(preview.rows).toHaveLength(7);
      expect(preview.rows[0]).toMatchObject({
        line: 6,
        status: 'ok',
        row: { amount: -2345, bookingDate: '2026-03-02' },
        duplicate: false,
      });
      expect(await rowsOf(a, acc)).toHaveLength(0);
    });

    it('limits the preview to 50 rows but counts them all', async () => {
      const acc = await account();
      const lines = Array.from({ length: 80 }, (_, i) => `2026-01-01,Row ${i},-${i + 1}.00`);
      const preview = await previewImport(a, {
        accountId: acc,
        file: csvFile(['Date,Description,Amount', ...lines].join('\n')),
      });
      expect(preview.rows).toHaveLength(50);
      expect(preview.stats).toMatchObject({ total: 80, valid: 80 });
    });

    it('marks rows that already exist as duplicates', async () => {
      const acc = await account();
      await commitImport(a, { accountId: acc, file: file('revolut.csv') });
      const preview = await previewImport(a, { accountId: acc, file: file('revolut.csv') });
      expect(preview.stats).toMatchObject({ valid: 3, skipped: 2, errors: 1, duplicates: 3 });
    });

    it('lets the user override the mapping', async () => {
      const acc = await account();
      const base = await previewImport(a, { accountId: acc, file: file('statement.xlsx') });
      const mapping: ColumnMapping = { ...base.mapping!, invertSign: true };
      const preview = await previewImport(a, {
        accountId: acc,
        file: file('statement.xlsx'),
        mapping,
      });
      const first = preview.rows.find((r) => r.status === 'ok');
      expect(first && first.status === 'ok' && first.row.amount).toBe(2345);
    });

    it('previews OFX without a mapping', async () => {
      const acc = await account();
      const preview = await previewImport(a, { accountId: acc, file: file('statement-v2.ofx') });
      expect(preview.presetKey).toBeNull();
      expect(preview.stats).toMatchObject({ total: 4, valid: 3, errors: 1 });
    });

    it('counts the same duplicates as the commit when a file id meets a connector row', async () => {
      const acc = await account();
      await ingestTransactions(
        a,
        acc,
        [
          {
            bookingDate: '2026-03-02',
            amount: -2345,
            currency: 'EUR',
            description: 'Cafe Fit',
            externalId: 'eb-1',
          },
        ],
        { source: 'connector' },
      );
      const ofx = `<?xml version="1.0"?><OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>EUR</CURDEF><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260302</DTPOSTED><TRNAMT>-23.45</TRNAMT><FITID>FIT-9</FITID><NAME>Cafe Fit</NAME></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
      const input = { accountId: acc, file: { buffer: Buffer.from(ofx), filename: 'x.ofx' } };
      const preview = await previewImport(a, input);
      const result = await commitImport(a, input);
      expect(preview.stats.duplicates).toBe(1);
      expect(result).toMatchObject({ inserted: 0, duplicates: 1 });
    });

    it('rejects unknown accounts, a missing layout and viewers cross-household', async () => {
      const acc = await account();
      await expect(
        previewImport(b, { accountId: acc, file: file('revolut.csv') }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        previewImport(a, { accountId: acc, file: csvFile('foo,bar\n1,2\n') }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects a mapping that is not valid', async () => {
      const acc = await account();
      await expect(
        previewImport(a, {
          accountId: acc,
          file: file('revolut.csv'),
          mapping: { dateColumn: 'x' } as unknown as ColumnMapping,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('commitImport', () => {
    it('imports the valid rows into a batch and records the counts', async () => {
      const acc = await account();
      const result = await commitImport(a, { accountId: acc, file: file('pt-bank-latin1.csv') });
      expect(result).toMatchObject({ inserted: 5, duplicates: 0, skipped: 2, errors: 0 });
      const rows = await rowsOf(a, acc);
      expect(rows).toHaveLength(5);
      expect(rows.every((r) => r.importBatchId === result.batchId && r.source === 'import')).toBe(
        true,
      );
      // The two identical coffees on the same day both survive.
      expect(rows.filter((r) => r.amount === -350)).toHaveLength(2);
      const [batch] = await withHousehold(a.db, a.householdId, (tx) =>
        tx.select().from(schema.importBatch).where(eq(schema.importBatch.id, result.batchId)),
      );
      expect(batch).toMatchObject({
        accountId: acc,
        source: 'csv',
        filename: 'pt-bank-latin1.csv',
        presetKey: 'pt_bank',
        rowsTotal: 7,
        rowsImported: 5,
        rowsDuplicate: 0,
        rowsSkipped: 2,
        createdBy: a.userId,
        undoneAt: null,
      });
    });

    it('importing the same file again inserts nothing', async () => {
      const acc = await account();
      await commitImport(a, { accountId: acc, file: file('pt-bank-latin1.csv') });
      const again = await commitImport(a, { accountId: acc, file: file('pt-bank-latin1.csv') });
      expect(again).toMatchObject({ inserted: 0, duplicates: 5 });
      expect(await rowsOf(a, acc)).toHaveLength(5);
    });

    it('an overlapping file only adds the new rows', async () => {
      const acc = await account();
      const head = 'Date,Description,Amount\n';
      await commitImport(a, {
        accountId: acc,
        file: csvFile(`${head}2026-02-01,Shop A,-1.00\n2026-02-02,Shop B,-2.00\n`),
      });
      const next = await commitImport(a, {
        accountId: acc,
        file: csvFile(`${head}2026-02-02,Shop B,-2.00\n2026-02-03,Shop C,-3.00\n`),
      });
      expect(next).toMatchObject({ inserted: 1, duplicates: 1 });
      expect(await rowsOf(a, acc)).toHaveLength(3);
    });

    it('imports OFX with FITID as the external id, and XLSX', async () => {
      const acc = await account();
      const ofx = await commitImport(a, { accountId: acc, file: file('statement-v1.ofx') });
      expect(ofx.inserted).toBe(3);
      expect((await rowsOf(a, acc)).map((r) => r.externalId).sort()).toEqual([
        'FIT-0001',
        'FIT-0002',
        'FIT-0003',
      ]);
      const acc2 = await account();
      const xlsx = await commitImport(a, { accountId: acc2, file: file('statement.xlsx') });
      expect(xlsx).toMatchObject({ inserted: 3, skipped: 2 });
    });

    it('stores pending Revolut rows as pending and subtracts the fee', async () => {
      const acc = await account();
      await commitImport(a, { accountId: acc, file: file('revolut.csv') });
      const rows = await rowsOf(a, acc);
      expect(rows.map((r) => [r.amount, r.status]).sort()).toEqual([
        [-1050, 'booked'],
        [-320, 'pending'],
        [10000, 'booked'],
      ]);
    });

    it('reports unparseable rows without importing them', async () => {
      const acc = await account();
      const result = await commitImport(a, { accountId: acc, file: file('statement-v2.ofx') });
      expect(result).toMatchObject({ inserted: 3, errors: 1, skipped: 0 });
    });

    it('saves the mapping as a household preset (unique per name, updated on re-save)', async () => {
      const acc = await account();
      const preview = await previewImport(a, { accountId: acc, file: file('statement.xlsx') });
      await commitImport(a, {
        accountId: acc,
        file: file('statement.xlsx'),
        mapping: preview.mapping!,
        saveAsPreset: { name: 'My bank' },
      });
      await commitImport(a, {
        accountId: acc,
        file: file('statement.xlsx'),
        mapping: { ...preview.mapping!, invertSign: true },
        saveAsPreset: { name: 'My bank' },
      });
      const presets = await listImportPresets(a);
      expect(presets).toHaveLength(1);
      expect(presets[0]).toMatchObject({ name: 'My bank', kind: 'xlsx' });
      expect(presets[0]!.mapping).toMatchObject({ invertSign: true });
      expect(await listImportPresets(b)).toEqual([]);
    });

    it('uses a saved household preset to recognise later files', async () => {
      const acc = await account();
      const csvText = 'Dia;Texto;Valor EUR\n01/04/2026;Padaria Exemplo;-2,10\n';
      const mapping: ColumnMapping = {
        dateColumn: 'Dia',
        descriptionColumn: 'Texto',
        amountColumn: 'Valor EUR',
        dateFormat: 'DMY',
        decimal: ',',
        headerRow: 0,
      };
      await commitImport(a, {
        accountId: acc,
        file: csvFile(csvText),
        mapping,
        saveAsPreset: { name: 'Odd bank' },
      });
      const next = await previewImport(a, {
        accountId: acc,
        file: csvFile('Dia;Texto;Valor EUR\n02/04/2026;Talho Exemplo;-9,99\n'),
      });
      expect(next.presetKey).toBe('household:Odd bank');
      expect(next.stats.valid).toBe(1);
    });

    it('refuses files with nothing to import, archived/foreign accounts and viewers', async () => {
      const acc = await account();
      await expect(
        commitImport(a, { accountId: acc, file: csvFile('Date,Description,Amount\n') }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        commitImport(b, { accountId: acc, file: file('revolut.csv') }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        commitImport(withRole(a, 'viewer'), { accountId: acc, file: file('revolut.csv') }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        undoImport(withRole(a, 'viewer'), '00000000-0000-4000-8000-000000000000'),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('refuses archived accounts and leaves no batch behind', async () => {
      const gone = await account();
      await archiveAccount(a, gone);
      const count = async () =>
        (await withHousehold(a.db, a.householdId, (tx) => tx.select().from(schema.importBatch)))
          .length;
      const before = await count();
      await expect(
        commitImport(a, { accountId: gone, file: file('revolut.csv') }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(await count()).toBe(before);
    });

    it('rejects OFX statements in another currency than the account', async () => {
      const usd = await account(a, 'USD');
      await expect(
        commitImport(a, { accountId: usd, file: file('statement-v1.ofx') }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('duplicate counting and pending replacement', () => {
    const mapping: ColumnMapping = {
      dateColumn: 'Date',
      descriptionColumn: 'Description',
      amountColumn: 'Amount',
      externalIdColumn: 'Ref',
      dateFormat: 'YMD',
      decimal: '.',
      headerRow: 0,
    };
    const head = 'Date,Description,Amount,Ref\n';

    async function arrange() {
      const acc = await account();
      const base = { bookingDate: '2026-05-01', currency: 'EUR' };
      await ingestTransactions(
        a,
        acc,
        [
          { ...base, amount: -500, description: 'Pending plain', status: 'pending' },
          {
            ...base,
            amount: -600,
            description: 'Pending ext',
            status: 'pending',
            externalId: 'X1',
          },
          { ...base, amount: -700, description: 'Already booked' },
        ],
        { source: 'connector' },
      );
      return acc;
    }
    const csv = [
      head,
      '2026-05-01,Pending plain,-5.00,\n', // replaces pending (same hash, no external ids)
      '2026-05-02,Pending ext moved,-6.10,X1\n', // replaces pending by external id
      '2026-05-01,Already booked,-7.00,\n', // duplicate by hash
      '2026-05-03,Brand new,-8.00,\n', // new
      '2026-05-04,Same ref first,-9.00,N1\n', // new
      '2026-05-05,Same ref second,-9.50,N1\n', // duplicate: external id repeated in the file
      '2026-05-06,Another new,-1.00,\n',
    ].join('');

    it('preview counts equal what commit does', async () => {
      const acc = await arrange();
      const preview = await previewImport(a, { accountId: acc, file: csvFile(csv), mapping });
      const result = await commitImport(a, { accountId: acc, file: csvFile(csv), mapping });
      expect(result).toMatchObject({ inserted: 3, duplicates: 2, pendingReplaced: 2 });
      expect(preview.stats.duplicates).toBe(result.duplicates);
      expect(preview.stats.valid - preview.stats.duplicates - result.pendingReplaced).toBe(
        result.inserted,
      );
    });

    it('rows replaced from pending move to the new batch, so undo deletes them', async () => {
      const acc = await arrange();
      const result = await commitImport(a, { accountId: acc, file: csvFile(csv), mapping });
      const rows = await rowsOf(a, acc);
      const replaced = rows.filter((r) =>
        ['Pending plain', 'Pending ext moved'].includes(r.rawDescription),
      );
      expect(replaced).toHaveLength(2);
      expect(
        replaced.every((r) => r.importBatchId === result.batchId && r.status === 'booked'),
      ).toBe(true);
      expect(await getImportBatchSummary(a, result.batchId)).toMatchObject({ rows: 5 });
      expect(await undoImport(a, result.batchId)).toMatchObject({ deleted: 5 });
    });
  });

  describe('getImportBatchSummary', () => {
    it('reports rows, edited rows and undone state without writing, and is household-scoped', async () => {
      const acc = await account();
      const batch = await commitImport(a, {
        accountId: acc,
        file: csvFile('Date,Description,Amount\n2026-02-01,One,-1.00\n2026-02-02,Two,-2.00\n'),
      });
      const [one] = (await rowsOf(a, acc)).filter((r) => r.rawDescription === 'One');
      await updateTransaction(a, one!.id, { notes: 'n' });
      expect(await getImportBatchSummary(a, batch.batchId)).toEqual({
        rows: 2,
        editedRows: 1,
        undoneAt: null,
      });
      await undoImport(a, batch.batchId);
      const after = await getImportBatchSummary(withRole(a, 'viewer'), batch.batchId);
      expect(after).toMatchObject({ rows: 0, editedRows: 0 });
      expect(after.undoneAt).toBeInstanceOf(Date);
      await expect(getImportBatchSummary(b, batch.batchId)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('listImportBatches', () => {
    it('lists batches newest first, optionally per account, household-scoped and limited', async () => {
      const acc1 = await account();
      const acc2 = await account();
      const head = 'Date,Description,Amount\n';
      const one = await commitImport(a, {
        accountId: acc1,
        file: csvFile(`${head}2026-05-01,List A,-1.00\n`, 'one.csv'),
      });
      const two = await commitImport(a, {
        accountId: acc2,
        file: csvFile(`${head}2026-05-02,List B,-2.00\n`, 'two.csv'),
      });
      await undoImport(a, one.batchId);

      const all = await listImportBatches(a, { limit: 100 });
      const ids = all.map((x) => x.id);
      expect(ids.indexOf(two.batchId)).toBeLessThan(ids.indexOf(one.batchId));
      const mine = await listImportBatches(a, { accountId: acc1 });
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ id: one.batchId, filename: 'one.csv', rowsImported: 1 });
      expect(mine[0]!.undoneAt).toBeInstanceOf(Date);
      expect(await listImportBatches(a, { limit: 1 })).toHaveLength(1);
      expect(await listImportBatches(b)).toEqual([]);
      await expect(listImportBatches(a, { accountId: 'nope' })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  describe('deleteImportPreset', () => {
    it('deletes a household preset, only in its own household and not for viewers', async () => {
      const acc = await account();
      const preview = await previewImport(a, { accountId: acc, file: file('statement.xlsx') });
      await commitImport(a, {
        accountId: acc,
        file: file('statement.xlsx'),
        mapping: preview.mapping!,
        saveAsPreset: { name: 'To delete' },
      });
      const [preset] = (await listImportPresets(a)).filter((p) => p.name === 'To delete');
      await expect(deleteImportPreset(b, preset!.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(deleteImportPreset(withRole(a, 'viewer'), preset!.id)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await deleteImportPreset(a, preset!.id);
      expect((await listImportPresets(a)).some((p) => p.name === 'To delete')).toBe(false);
      await expect(deleteImportPreset(a, preset!.id)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('undoImport', () => {
    it('deletes only the rows of that batch and marks it undone', async () => {
      const acc = await account();
      const head = 'Date,Description,Amount\n';
      const first = await commitImport(a, {
        accountId: acc,
        file: csvFile(`${head}2026-02-01,Keep A,-1.00\n2026-02-02,Keep B,-2.00\n`),
      });
      const second = await commitImport(a, {
        accountId: acc,
        file: csvFile(`${head}2026-02-03,Drop A,-3.00\n2026-02-04,Drop B,-4.00\n`),
      });
      const manual = await createManualTransaction(a, {
        accountId: acc,
        bookingDate: '2026-02-05',
        amount: -5,
        description: 'Manual keeper',
      });
      expect(await undoImport(a, second.batchId)).toEqual({ deleted: 2, editedRows: 0 });
      const left = (await rowsOf(a, acc)).map((r) => r.rawDescription).sort();
      expect(left).toEqual(['Keep A', 'Keep B', manual.rawDescription]);
      const [batch] = await withHousehold(a.db, a.householdId, (tx) =>
        tx.select().from(schema.importBatch).where(eq(schema.importBatch.id, second.batchId)),
      );
      expect(batch!.undoneAt).toBeInstanceOf(Date);
      const [other] = await withHousehold(a.db, a.householdId, (tx) =>
        tx.select().from(schema.importBatch).where(eq(schema.importBatch.id, first.batchId)),
      );
      expect(other!.undoneAt).toBeNull();
      await expect(undoImport(a, second.batchId)).rejects.toBeInstanceOf(ValidationError);
    });

    it('reports how many deleted rows the user had edited', async () => {
      const acc = await account();
      const batch = await commitImport(a, {
        accountId: acc,
        file: csvFile(
          'Date,Description,Amount\n2026-02-01,Edit me,-1.00\n2026-02-02,Leave me,-2.00\n',
        ),
      });
      const [edit] = (await rowsOf(a, acc)).filter((r) => r.rawDescription === 'Edit me');
      await updateTransaction(a, edit!.id, { notes: 'mine' });
      expect(await undoImport(a, batch.batchId)).toEqual({ deleted: 2, editedRows: 1 });
    });

    it('unlinks transfers: the surviving leg becomes uncategorised and reviewable', async () => {
      const from = await account();
      const to = await account();
      const out = await commitImport(a, {
        accountId: from,
        file: csvFile('Date,Description,Amount\n2026-03-10,Move out,-777.01\n'),
      });
      const inn = await ingestTransactions(
        a,
        to,
        [{ bookingDate: '2026-03-10', amount: 77_701, currency: 'EUR', description: 'Move in' }],
        { source: 'connector' },
      );
      const survivor = await getTransaction(a, inn.insertedIds[0]!);
      expect(survivor.transferGroupId).toBeTruthy();
      expect(await undoImport(a, out.batchId)).toMatchObject({ deleted: 1 });
      expect(await getTransaction(a, survivor.id)).toMatchObject({
        transferGroupId: null,
        categoryId: null,
        needsReview: true,
      });
    });

    it('does not mark the survivor as user-edited or lock it against future pairing', async () => {
      const from = await account();
      const to = await account();
      const out = await commitImport(a, {
        accountId: from,
        file: csvFile('Date,Description,Amount\n2026-03-11,Move out,-888.02\n'),
      });
      const inn = await ingestTransactions(
        a,
        to,
        [{ bookingDate: '2026-03-11', amount: 88_802, currency: 'EUR', description: 'Move in' }],
        { source: 'connector' },
      );
      await undoImport(a, out.batchId);
      expect(await getTransaction(a, inn.insertedIds[0]!)).toMatchObject({
        userEditedAt: null,
        transferLocked: false,
      });
      // Re-importing the file restores the pairing.
      await commitImport(a, {
        accountId: from,
        file: csvFile('Date,Description,Amount\n2026-03-11,Move out,-888.02\n'),
      });
      expect((await getTransaction(a, inn.insertedIds[0]!)).transferGroupId).toBeTruthy();
    });

    it('is household-scoped and rejects unknown ids', async () => {
      const acc = await account();
      const batch = await commitImport(a, { accountId: acc, file: file('revolut.csv') });
      await expect(undoImport(b, batch.batchId)).rejects.toBeInstanceOf(NotFoundError);
      await expect(undoImport(a, 'nope')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('keeps rows of other imports and manual transfer links intact', async () => {
      const x = await account();
      const y = await account();
      const m1 = await createManualTransaction(a, {
        accountId: x,
        bookingDate: '2026-03-12',
        amount: -99_903,
        description: 'manual out',
      });
      const m2 = await createManualTransaction(a, {
        accountId: y,
        bookingDate: '2026-03-12',
        amount: 99_903,
        description: 'manual in',
      });
      await markTransfer(a, m1.id, m2.id);
      const batch = await commitImport(a, { accountId: x, file: file('revolut.csv') });
      await undoImport(a, batch.batchId);
      expect((await getTransaction(a, m1.id)).transferGroupId).toBeTruthy();
    });
  });
});
