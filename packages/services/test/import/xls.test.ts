import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

  it('ignores the high half of the stream size, which old writers left uninitialised', () => {
    const payload = patterned(5000);
    const file = buildCfb(payload, { sizeHigh: 0xdeadbeef });
    expect(readWorkbookStream(file).equals(payload)).toBe(true);
  });

  it('reports an encrypted Office document as password-protected', () => {
    expectInvalid(
      () => readWorkbookStream(buildCfb(patterned(5000), { name: 'EncryptedPackage' })),
      'The workbook is password-protected',
    );
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

  describe('directory tree', () => {
    const payload = patterned(5000);
    const entryAt = (id: number) => id * 128;
    const LEFT = 68;
    const RIGHT = 72;
    const CHILD = 76;

    it('ignores a Workbook stream inside a sub-storage listed before the real one', () => {
      const file = buildCfb(payload, { decoyStorage: true });
      expect(readWorkbookStream(file).equals(payload)).toBe(true);
    });

    it('does not descend into a storage, even when it holds the only Workbook stream', () => {
      const file = buildCfb(payload, {
        decoyStorage: true,
        dirPatch: (dir) => dir.writeUInt32LE(0xffffffff, entryAt(1) + RIGHT),
      });
      expectInvalid(() => readWorkbookStream(file));
    });

    it('finds the stream through a left sibling', () => {
      const file = buildCfb(payload, {
        decoyStorage: true,
        dirPatch: (dir) => {
          dir.writeUInt32LE(3, entryAt(0) + CHILD);
          dir.writeUInt32LE(0xffffffff, entryAt(1) + RIGHT);
          dir.writeUInt32LE(1, entryAt(3) + LEFT);
        },
      });
      expect(readWorkbookStream(file).equals(payload)).toBe(true);
    });

    it('rejects a stream that the root cannot reach', () => {
      const file = buildCfb(payload, {
        dirPatch: (dir) => dir.writeUInt32LE(0xffffffff, entryAt(0) + CHILD),
      });
      expectInvalid(() => readWorkbookStream(file));
    });

    it('rejects a tree that loops back on itself', () => {
      const file = buildCfb(payload, {
        name: 'Other',
        dirPatch: (dir) => dir.writeUInt32LE(1, entryAt(1) + RIGHT),
      });
      expectInvalid(() => readWorkbookStream(file));
      const loopBeforeStream = buildCfb(payload, {
        decoyStorage: true,
        dirPatch: (dir) => dir.writeUInt32LE(1, entryAt(1) + LEFT),
      });
      expectInvalid(() => readWorkbookStream(loopBeforeStream));
    });

    it('rejects a sibling id outside the directory', () => {
      const file = buildCfb(payload, {
        decoyStorage: true,
        dirPatch: (dir) => dir.writeUInt32LE(99, entryAt(1) + LEFT),
      });
      expectInvalid(() => readWorkbookStream(file));
    });
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

  it('does not treat bracketed colours and locale tags as a date format', () => {
    const cells = ['[Red]0.00', '[$-409]#,##0.00', '[Blue]General'].map((format) => ({
      date: 12.5,
      format,
    }));
    expect(one([cells])).toEqual([['12.5', '12.5', '12.5']]);
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

    it('rejects an inline label holding too much text', () => {
      expectInvalid(() => one([['a', { label: 'x'.repeat(MAX_XLSX_CELL_CHARS + 1) }]]), 'too much');
    });

    it('rejects a record that runs past the end of the stream', () => {
      const stream = buildWorkbookStream([{ rows: [['a', 1, 2, 3]] }]);
      expectInvalid(() => parseXls(buildCfb(stream.subarray(0, stream.length - 10))));
    });

    it('rejects a shared string index beyond the table', () => {
      expectInvalid(() => one([['a', { sst: 5 }]]));
    });

    it('rejects a shared string table that claims an impossible number of strings', () => {
      const stream = buildWorkbookStream([{ rows: [['a']] }]);
      const sst = stream.indexOf(Buffer.from([0xfc, 0x00]));
      stream.writeUInt32LE(1_000_000, sst + 8);
      expectInvalid(() => parseXls(buildCfb(stream)));
    });

    it('rejects a shared string cut inside its characters', () => {
      const stream = buildWorkbookStream([{ rows: [['abcdefgh']] }]);
      const sst = stream.indexOf(Buffer.from([0xfc, 0x00]));
      stream.writeUInt16LE(20, sst + 4 + 8); // claims 20 characters, holds 8
      expectInvalid(() => parseXls(buildCfb(stream)));
    });
  });
});

describe('parseXls: shared strings', () => {
  const tooLong = 'x'.repeat(MAX_XLSX_CELL_CHARS + 1);

  it('accepts an over-limit text that only another sheet uses', () => {
    const file = buildXls([{ rows: [['ok', 'fine']] }, { rows: [[tooLong]] }]);
    expect(parseXls(file)).toEqual([['ok', 'fine']]);
  });

  it('accepts an over-limit text that only a hidden sheet uses', () => {
    const file = buildXls([{ hidden: true, rows: [[tooLong]] }, { rows: [['visible']] }]);
    expect(parseXls(file)).toEqual([['visible']]);
  });

  it('keeps reading the strings after an over-limit one', () => {
    const file = buildXls([{ rows: [['before', 'after']] }, { rows: [['before', tooLong, 'z']] }]);
    expect(parseXls(file)).toEqual([['before', 'after']]);
    const second = buildXls([{ rows: [['a', tooLong, 'z']] }, { rows: [['z']] }]);
    expectInvalid(() => parseXls(second), 'too much text');
  });

  describe('a table shorter than its declared count', () => {
    /** The declared unique count of the SST, raised to `declared`. */
    function declare(stream: Buffer, declared: number): Buffer {
      stream.writeUInt32LE(declared, stream.indexOf(Buffer.from([0xfc, 0x00])) + 8);
      return buildCfb(stream);
    }

    it('keeps the strings read when the table ends at a string boundary', () => {
      const stream = buildWorkbookStream([{ rows: [['a', 'b']] }]);
      expect(parseXls(declare(stream, 5))).toEqual([['a', 'b']]);
    });

    it('stops at the end of the CONTINUE data too', () => {
      const rows = [['Café Açúcar € Exemplo', '€uro Example Shop Central']];
      const stream = buildWorkbookStream([{ rows }], { sstChunk: 7 });
      expect(parseXls(declare(stream, 9))).toEqual(rows);
    });

    it('still rejects a shared string index past the strings read', () => {
      const stream = buildWorkbookStream([{ rows: [['a', { sst: 1 }]] }]);
      expectInvalid(() => parseXls(declare(stream, 3)));
    });
  });
});

/** Files written by LibreOffice (fictional data), so the reader is checked against a real writer. */
describe('parseXls: files written by LibreOffice', () => {
  const fixture = (name: string) =>
    readFileSync(fileURLToPath(new URL(`../fixtures/import/${name}`, import.meta.url)));

  it('reads a small workbook stored in the mini stream', () => {
    const file = fixture('libreoffice-small.xls');
    expect(readWorkbookStream(file).length).toBeLessThan(4096);
    expect(parseXls(file)).toEqual([
      ['Date', 'Description', 'Amount', 'Balance'],
      ['2026-03-02', 'Café Açúcar Exemplo €', '-23.45', '1976.55'],
      ['2026-03-03', 'Salary Example Corp', '1500', '3476.55'],
    ]);
  });

  it('reads a long non-ASCII text that spans several records', () => {
    const long = 'Padaria Exemplo € '.repeat(520).trim();
    expect(parseXls(fixture('libreoffice-long-text.xls'))).toEqual([
      ['Date', 'Description', 'Amount'],
      ['2026-03-05', long, '-1234.56'],
      ['2026-03-06', 'Rent Example', '-700'],
    ]);
  });
});
