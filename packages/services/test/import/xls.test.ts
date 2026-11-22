import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_ROWS, ValidationError } from '../../src/index.js';
import { parseXls, readWorkbookStream } from '../../src/import/xls.js';
import { MAX_XLSX_CELL_CHARS, MAX_XLSX_COLUMNS } from '../../src/import/xlsx.js';
import { buildCfb, buildWorkbookStream, buildXls, type XlsCell } from './xls-builder.js';

const INVALID = 'The file is not a valid XLS workbook';

const patterned = (length: number) => Buffer.from(Array.from({ length }, (_, i) => (i * 7) % 251));

function expectInvalid(run: () => unknown, message = INVALID): void {
  expect(run).toThrow(ValidationError);
  expect(run).toThrow(message);
}

describe('readWorkbookStream', () => {
  it('returns the Workbook stream of a regular compound file', () => {
    const payload = patterned(5000);
    expect(readWorkbookStream(buildCfb(payload)).equals(payload)).toBe(true);
  });

  it('reads a workbook stored in the mini stream', () => {
    const payload = patterned(300);
    expect(readWorkbookStream(buildCfb(payload, { mini: true })).equals(payload)).toBe(true);
  });

  it('accepts the legacy stream name Book', () => {
    const payload = patterned(5000);
    expect(readWorkbookStream(buildCfb(payload, { name: 'Book' })).equals(payload)).toBe(true);
  });

  it('rejects a file without the compound signature', () => {
    expectInvalid(() => readWorkbookStream(Buffer.alloc(2048, 0x41)));
  });

  it('rejects a truncated file', () => {
    expectInvalid(() => readWorkbookStream(buildCfb(patterned(5000)).subarray(0, 600)));
  });

  it('rejects a looping sector chain', () => {
    const file = buildCfb(patterned(5000), { fatPatch: (fat) => (fat[0] = 0) });
    expectInvalid(() => readWorkbookStream(file));
  });

  it('rejects a chain pointing outside the file', () => {
    const file = buildCfb(patterned(5000), { fatPatch: (fat) => (fat[0] = 9000) });
    expectInvalid(() => readWorkbookStream(file));
  });

  it('rejects a compound file without a workbook stream', () => {
    expectInvalid(() => readWorkbookStream(buildCfb(patterned(5000), { name: 'Other' })));
  });
});

const one = (rows: XlsCell[][], opts?: Parameters<typeof buildXls>[1]) =>
  parseXls(buildXls([{ rows }], opts));

describe('parseXls', () => {
  it('reads text and numbers as plain strings', () => {
    expect(
      one([
        ['Date', 'Description', 'Amount'],
        ['02/03/2026', 'Grocer Example', -23.45],
        ['03/03/2026', 'Salary Example Corp', 1500],
      ]),
    ).toEqual([
      ['Date', 'Description', 'Amount'],
      ['02/03/2026', 'Grocer Example', '-23.45'],
      ['03/03/2026', 'Salary Example Corp', '1500'],
    ]);
  });

  it('keeps non-ASCII text', () => {
    expect(one([['Café Açúcar €', 'Mercearia Exemplo']])).toEqual([
      ['Café Açúcar €', 'Mercearia Exemplo'],
    ]);
  });

  it('joins strings split across CONTINUE records', () => {
    const row = ['Café Açúcar € Exemplo', '€uro Example Shop Central', 'Plain ASCII description'];
    expect(one([row, ['after']], { sstChunk: 7 })).toEqual([row, ['after']]);
  });

  it('reads a shared string table larger than one record', () => {
    const rows = Array.from({ length: 600 }, (_, i) => [`Description number ${i} for a row`]);
    expect(one(rows)).toEqual(rows);
  });

  it('decodes RK numbers', () => {
    const rks = [{ rk: (1500 << 2) | 2 }, { rk: ((-2345 << 2) | 3) >>> 0 }, { rk: 0x3fe00000 }];
    expect(one([rks])).toEqual([['1500', '-23.45', '0.5']]);
  });

  it('decodes adjacent RK numbers written as one MULRK', () => {
    const rks = [{ rk: (1500 << 2) | 2 }, { rk: ((-2345 << 2) | 3) >>> 0 }, { rk: 0x3fe00000 }];
    const file = buildXls([{ rows: [['a', ...rks, 'z']], mulrk: true }]);
    expect(parseXls(file)).toEqual([['a', '1500', '-23.45', '0.5', 'z']]);
  });

  it('turns date-formatted numbers into ISO dates', () => {
    expect(
      one([[{ date: 46083 }, { date: 46083, format: 'dd/mm/yyyy' }, { date: 46083.75 }]]),
    ).toEqual([['2026-03-02', '2026-03-02', '2026-03-02']]);
  });

  it('honours the 1904 date system', () => {
    expect(one([[{ date: 44621 }]], { date1904: true })).toEqual([['2026-03-02']]);
  });

  it('does not treat quoted letters as a date format', () => {
    expect(one([[{ date: 12.5, format: '0.00" dias"' }]])).toEqual([['12.5']]);
  });

  it('reads the cached result of a formula, never the formula', () => {
    expect(one([[{ formula: 7 }, { formula: 'text result' }]])).toEqual([['7', 'text result']]);
  });

  it('reads booleans and legacy inline labels', () => {
    expect(one([[{ bool: true }, { bool: false }, { label: 'Old' }]])).toEqual([
      ['TRUE', 'FALSE', 'Old'],
    ]);
  });

  it('leaves blank cells empty and pads gaps', () => {
    expect(one([['a', null, 'c'], [], ['d']])).toEqual([['a', '', 'c'], [], ['d']]);
  });

  it('skips hidden sheets', () => {
    const file = buildXls([{ hidden: true, rows: [['hidden']] }, { rows: [['visible']] }]);
    expect(parseXls(file)).toEqual([['visible']]);
  });

  it('reads a workbook small enough for the mini stream and one that is not', () => {
    expect(buildWorkbookStream([{ rows: [['a']] }]).length).toBeLessThan(4096);
    expect(one([['a']])).toEqual([['a']]);
    const rows = Array.from({ length: 400 }, (_, i) => [i, i + 0.5]);
    expect(buildWorkbookStream([{ rows }]).length).toBeGreaterThan(4096);
    expect(one(rows)[399]).toEqual(['399', '399.5']);
  });

  describe('rejections', () => {
    it('rejects a password-protected workbook', () => {
      expectInvalid(() => one([['a']], { filepass: true }), 'The workbook is password-protected');
    });

    it('rejects Excel 95 and older', () => {
      expectInvalid(
        () => one([['a']], { biffVersion: 0x0500 }),
        'Excel 95 and older workbooks are not supported',
      );
    });

    it('rejects a workbook whose sheets are all hidden', () => {
      expectInvalid(
        () => parseXls(buildXls([{ hidden: true, rows: [['a']] }])),
        'The workbook has no visible worksheet',
      );
    });

    it('rejects an empty sheet', () => {
      expectInvalid(() => one([]), 'The spreadsheet is empty');
    });

    it('rejects a cell beyond the row limit', () => {
      const file = buildXls([{ firstRow: MAX_IMPORT_ROWS, rows: [['a']] }]);
      expectInvalid(() => parseXls(file), `too many rows (maximum ${MAX_IMPORT_ROWS} rows)`);
      expect(parseXls(buildXls([{ firstRow: MAX_IMPORT_ROWS - 1, rows: [['a']] }]))).toHaveLength(
        MAX_IMPORT_ROWS,
      );
    });

    it('rejects a cell beyond the column limit', () => {
      const file = buildXls([{ firstCol: MAX_XLSX_COLUMNS, rows: [['a']] }]);
      expectInvalid(() => parseXls(file), `too many columns (maximum ${MAX_XLSX_COLUMNS})`);
    });

    it('rejects a cell holding too much text', () => {
      expectInvalid(() => one([['x'.repeat(MAX_XLSX_CELL_CHARS + 1)]]), 'too much text');
      expect(one([['x'.repeat(MAX_XLSX_CELL_CHARS)]])[0]![0]).toHaveLength(MAX_XLSX_CELL_CHARS);
    });

    it('rejects a record that runs past the end of the stream', () => {
      const stream = buildWorkbookStream([{ rows: [['a', 1, 2, 3]] }]);
      expectInvalid(() => parseXls(buildCfb(stream.subarray(0, stream.length - 10))));
    });

    it('rejects a shared string index beyond the table', () => {
      expectInvalid(() => one([['a', { sst: 5 }]]));
    });

    it('rejects a shared string table that claims more strings than it holds', () => {
      const stream = buildWorkbookStream([{ rows: [['a']] }]);
      const sst = stream.indexOf(Buffer.from([0xfc, 0x00]));
      stream.writeUInt32LE(1_000_000, sst + 8);
      expectInvalid(() => parseXls(buildCfb(stream)));
    });
  });
});
