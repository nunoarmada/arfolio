import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { foldHeader } from '../../src/import/headers.js';
import {
  applyMapping,
  detectPreset,
  parseFile,
  presetMapping,
  type ColumnMapping,
} from '../../src/index.js';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/import/${name}`, import.meta.url)));
const csv = (text: string) => parseFile(Buffer.from(text, 'utf8'), 'x.csv');
const okRows = (rows: ReturnType<typeof applyMapping>) =>
  rows.flatMap((r) => (r.status === 'ok' ? [r.row] : []));

describe('detectPreset', () => {
  it('recognises the Revolut export by its exact headers', async () => {
    expect(detectPreset(await parseFile(fixture('revolut.csv'), 'r.csv'))).toBe('revolut');
  });

  it('recognises Portuguese bank layouts by Data Mov / Descrição / Débito / Crédito', async () => {
    expect(detectPreset(await parseFile(fixture('pt-bank-latin1.csv'), 'e.csv'))).toBe('pt_bank');
  });

  it('falls back to generic for English date/description/amount headers (csv and xlsx)', async () => {
    expect(detectPreset(await csv('Date,Description,Amount\n2026-03-01,A,1\n'))).toBe('generic');
    expect(detectPreset(await parseFile(fixture('statement.xlsx'), 's.xlsx'))).toBe('generic');
  });

  it('returns null when no layout is recognisable, and for OFX (no mapping needed)', async () => {
    expect(detectPreset(await csv('foo,bar\n1,2\n'))).toBeNull();
    expect(detectPreset(await parseFile(fixture('statement-v2.ofx'), 'a.ofx'))).toBeNull();
  });
});

describe('applyMapping', () => {
  it('maps the pt-PT export: debit/credit, dd-mm-yyyy, comma decimals; blank and footer rows are skipped', async () => {
    const table = await parseFile(fixture('pt-bank-latin1.csv'), 'e.csv');
    const rows = applyMapping(table, presetMapping('pt_bank', table), { currency: 'EUR' });
    expect(rows).toHaveLength(7);
    expect(okRows(rows)).toEqual([
      {
        bookingDate: '2026-03-02',
        valueDate: '2026-03-02',
        amount: -2345,
        currency: 'EUR',
        description: 'COMPRA Mercearia Exemplo 0123',
      },
      {
        bookingDate: '2026-03-03',
        valueDate: '2026-03-04',
        amount: 150000,
        currency: 'EUR',
        description: 'TRF Salário Empresa Exemplo',
      },
      {
        bookingDate: '2026-03-05',
        valueDate: '2026-03-05',
        amount: -123456,
        currency: 'EUR',
        description: 'Pagamento Café Central',
      },
      expect.objectContaining({ amount: -350, bookingDate: '2026-03-06' }),
      expect.objectContaining({ amount: -350, bookingDate: '2026-03-06' }),
    ]);
    expect(
      rows.filter((r) => r.status === 'skipped').map((r) => r.status === 'skipped' && r.reason),
    ).toEqual(['empty', 'summary']);
  });

  it('maps Revolut: amount minus fee, pending/booked, skips reverted/declined, flags foreign currency', async () => {
    const table = await parseFile(fixture('revolut.csv'), 'r.csv');
    const rows = applyMapping(table, presetMapping('revolut', table), { currency: 'EUR' });
    expect(rows.map((r) => r.status)).toEqual(['ok', 'ok', 'ok', 'skipped', 'skipped', 'error']);
    expect(okRows(rows)).toEqual([
      {
        bookingDate: '2026-03-01',
        valueDate: '2026-03-02',
        amount: -1050,
        currency: 'EUR',
        description: 'Bakery Example',
        status: 'booked',
      },
      {
        bookingDate: '2026-03-03',
        valueDate: '2026-03-03',
        amount: 10000,
        currency: 'EUR',
        description: 'Top-up by *1234',
        status: 'booked',
      },
      {
        bookingDate: '2026-03-04',
        amount: -320,
        currency: 'EUR',
        description: 'Coffee Roasters Example',
        status: 'pending',
      },
    ]);
    const err = rows.find((r) => r.status === 'error');
    expect(err && err.status === 'error' && err.error).toMatch(/currency/i);
  });

  it('maps the xlsx fixture: serial/ISO dates, numeric cells, totals footer skipped', async () => {
    const table = await parseFile(fixture('statement.xlsx'), 's.xlsx');
    const rows = applyMapping(table, presetMapping('generic', table), { currency: 'EUR' });
    expect(okRows(rows).map((r) => [r.bookingDate, r.amount, r.description])).toEqual([
      ['2026-03-02', -2345, 'Grocer Example'],
      ['2026-03-03', 150000, 'Salary Example Corp'],
      ['2026-03-05', -123456, 'Rent Example'],
    ]);
    expect(rows.filter((r) => r.status === 'skipped')).toHaveLength(2);
  });

  it('accepts Portuguese headers on a single amount column, and invertSign/decimal overrides', async () => {
    const table = await csv('Data;Descrição;Montante\n05/03/2026;Loja Exemplo;-1.234,5\n');
    const mapping = presetMapping('generic', table);
    expect(mapping).toMatchObject({
      dateColumn: 'Data',
      descriptionColumn: 'Descrição',
      amountColumn: 'Montante',
    });
    expect(okRows(applyMapping(table, mapping, { currency: 'EUR' }))[0]).toMatchObject({
      bookingDate: '2026-03-05',
      amount: -123450,
    });
    const inverted: ColumnMapping = { ...mapping, invertSign: true, decimal: ',' };
    expect(okRows(applyMapping(table, inverted, { currency: 'EUR' }))[0]!.amount).toBe(123450);
  });

  it('reports per-row errors instead of throwing, and honours skipRowsMatching and filterColumn', async () => {
    const table = await csv(
      'Date,Description,Amount,Kind\n2026-13-45,Bad date,1,a\n2026-03-01,Bad amount,abc,a\n2026-03-02,Fine,2.00,a\n2026-03-03,Ignore me,3.00,b\nSubtotal,,9.00,a\n',
    );
    const mapping: ColumnMapping = {
      ...presetMapping('generic', table),
      dateFormat: 'YMD',
      skipRowsMatching: ['subtotal'],
      filterColumn: { column: 'Kind', equals: ['a'] },
    };
    const rows = applyMapping(table, mapping, { currency: 'EUR' });
    expect(rows.map((r) => r.status)).toEqual(['error', 'error', 'ok', 'skipped', 'skipped']);
  });

  it('errors on rows missing a description, and when a mapped column is absent from the header', async () => {
    const table = await csv('Date,Description,Amount\n2026-03-01,,5.00\n');
    const rows = applyMapping(table, presetMapping('generic', table), { currency: 'EUR' });
    expect(rows[0]!.status).toBe('error');
    expect(() =>
      applyMapping(
        table,
        { ...presetMapping('generic', table), amountColumn: 'Nope' },
        { currency: 'EUR' },
      ),
    ).toThrow(/Nope/);
  });

  it('carries external ids and counterparties when mapped', async () => {
    const table = await csv(
      'Date,Description,Amount,Ref,Payee\n2026-03-01,Shop,-1.00,R-1,Shop Ltd\n',
    );
    const mapping: ColumnMapping = {
      ...presetMapping('generic', table),
      externalIdColumn: 'Ref',
      counterpartyColumn: 'Payee',
    };
    expect(okRows(applyMapping(table, mapping, { currency: 'EUR' }))[0]).toMatchObject({
      externalId: 'R-1',
      counterparty: 'Shop Ltd',
    });
  });

  it('reports sheet numbers with three or more decimals as row errors instead of scaling them', async () => {
    const table = await parseFile(fixture('statement.xlsx'), 's.xlsx');
    const grid = table.grid.map((r) => [...r]);
    grid[table.headerRow + 1]![2] = '1.234';
    const mapping = { ...presetMapping('generic', table), decimal: ',' as const };
    const rows = applyMapping({ ...table, grid }, mapping, { currency: 'EUR' });
    expect(rows[0]).toMatchObject({ status: 'error' });
    expect(rows[1]).toMatchObject({ status: 'ok' });
  });

  it('keeps header folding linear on pathological cells', () => {
    const started = Date.now();
    expect(foldHeader('x' + '.'.repeat(5_000_000))).toBe('x');
    expect(Date.now() - started).toBeLessThan(500);
  });
});
