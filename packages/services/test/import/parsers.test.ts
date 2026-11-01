import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { deflateRawSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, parseFile, ValidationError } from '../../src/index.js';
import { assertSafeXlsxArchive } from '../../src/import/xlsx.js';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/import/${name}`, import.meta.url)));

describe('parseFile: csv', () => {
  it('decodes windows-1252, detects ; and finds the header below the title rows', async () => {
    const table = await parseFile(fixture('pt-bank-latin1.csv'), 'extrato.csv');
    expect(table.kind).toBe('csv');
    expect(table.headerRow).toBe(4);
    expect(table.headers).toEqual([
      'Data Mov.',
      'Data Valor',
      'Descrição',
      'Débito',
      'Crédito',
      'Saldo',
    ]);
    expect(table.rows[0]).toEqual([
      '02-03-2026',
      '02-03-2026',
      'COMPRA Mercearia Exemplo 0123',
      '23,45',
      '',
      '1.976,55',
    ]);
    expect(table.rows[1]![2]).toBe('TRF Salário Empresa Exemplo');
  });

  it('reads UTF-8 with a BOM and comma delimiters, keeping quoted separators', async () => {
    const text = '﻿Date,Description,Amount\n2026-03-01,"Shop, Example ""Ltd""",-1.50\n';
    const table = await parseFile(Buffer.from(text, 'utf8'), 'x.csv');
    expect(table.headers).toEqual(['Date', 'Description', 'Amount']);
    expect(table.rows).toEqual([['2026-03-01', 'Shop, Example "Ltd"', '-1.50']]);
  });

  it('detects tab delimiters', async () => {
    const table = await parseFile(
      Buffer.from('Date\tDescription\tAmount\n2026-03-01\tA\t1\n'),
      'x.tsv',
    );
    expect(table.headers).toEqual(['Date', 'Description', 'Amount']);
  });

  it('rejects unknown extensions, empty files and unterminated quotes', async () => {
    await expect(parseFile(Buffer.from('x'), 'x.pdf')).rejects.toBeInstanceOf(ValidationError);
    await expect(parseFile(Buffer.alloc(0), 'x.csv')).rejects.toBeInstanceOf(ValidationError);
    await expect(parseFile(Buffer.from('a,b\n"open,1\n'), 'x.csv')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('enforces the file size and row limits', async () => {
    await expect(parseFile(Buffer.alloc(MAX_IMPORT_BYTES + 1, 0x61), 'big.csv')).rejects.toThrow(
      /10 MB/,
    );
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `2026-01-01,r${i},1`);
    await expect(
      parseFile(Buffer.from(['Date,Description,Amount', ...rows].join('\n')), 'many.csv'),
    ).rejects.toThrow(/50000 rows/);
  });
});

describe('parseFile: ofx', () => {
  const expected = [
    {
      externalId: 'FIT-0001',
      bookingDate: '2026-03-02',
      amount: -2345,
      currency: 'EUR',
      description: 'Mercearia Exemplo Compra 0123 & co',
    },
    {
      externalId: 'FIT-0002',
      bookingDate: '2026-03-03',
      amount: 150000,
      currency: 'EUR',
      description: 'Salario Empresa Exemplo',
    },
    {
      externalId: 'FIT-0003',
      bookingDate: '2026-03-05',
      amount: -123456,
      currency: 'EUR',
      description: 'Rent Example',
    },
  ];

  it('reads OFX 2.x XML into normalised rows, reporting broken transactions', async () => {
    const table = await parseFile(fixture('statement-v2.ofx'), 'a.ofx');
    expect(table.kind).toBe('ofx');
    expect(table.ofx!.currency).toBe('EUR');
    expect(table.ofx!.rows.filter((r) => r.status === 'ok').map((r) => r.row)).toEqual(expected);
    const broken = table.ofx!.rows.filter((r) => r.status === 'error');
    expect(broken).toHaveLength(1);
  });

  it('reads OFX 1.x SGML (unclosed tags) the same way', async () => {
    const table = await parseFile(fixture('statement-v1.ofx'), 'a.ofx');
    expect(table.ofx!.rows.map((r) => (r.status === 'ok' ? r.row : r))).toEqual(expected);
  });

  it('rejects files holding more than one statement', async () => {
    const one = fixture('statement-v2.ofx').toString('utf8');
    const body = /<STMTRS>[\s\S]*<\/STMTRS>/.exec(one)![0];
    const doubled = one.replace(body, body + body);
    await expect(parseFile(Buffer.from(doubled), 'two.ofx')).rejects.toThrow(/multiple statements/);
  });

  it('rejects a file without statement transactions', async () => {
    await expect(parseFile(Buffer.from('<OFX></OFX>'), 'x.ofx')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('parseFile: xlsx', () => {
  it('reads title rows, real dates, numbers and a totals footer as plain strings', async () => {
    const table = await parseFile(fixture('statement.xlsx'), 'statement.xlsx');
    expect(table.kind).toBe('xlsx');
    expect(table.headerRow).toBe(3);
    expect(table.headers).toEqual(['Date', 'Description', 'Amount', 'Balance']);
    expect(table.rows.slice(0, 3)).toEqual([
      ['2026-03-02', 'Grocer Example', '-23.45', '1976.55'],
      ['2026-03-03', 'Salary Example Corp', '1500', '3476.55'],
      ['2026-03-05', 'Rent Example', '-1234.56', '2241.99'],
    ]);
    const footer = table.rows.at(-1)!;
    expect(footer[0]).toBe('Total');
  });

  it('never evaluates formulas: only the stored result is read', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['Date', 'Description', 'Amount']);
    ws.addRow([
      '2026-03-01',
      '=HYPERLINK("http://example.com","x")',
      { formula: '1+1', result: 7 },
    ]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const table = await parseFile(buf, 'f.xlsx');
    expect(table.rows[0]).toEqual(['2026-03-01', '=HYPERLINK("http://example.com","x")', '7']);
  });

  it('rejects an archive whose entries inflate far beyond their size (zip bomb)', async () => {
    const bomb = zip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(150 * 1024 * 1024) }]);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    await expect(parseFile(bomb, 'bomb.xlsx')).rejects.toThrow(/too large when unpacked/);
  });

  it('rejects an archive that understates its unpacked size', async () => {
    const liar = zip([
      {
        name: 'xl/worksheets/sheet1.xml',
        data: Buffer.alloc(150 * 1024 * 1024),
        declaredSize: 1024,
      },
    ]);
    await expect(parseFile(liar, 'liar.xlsx')).rejects.toThrow(/entry size mismatch/);
  });

  it('rejects a worksheet entry above 25 MiB and archives above 30 MiB in total', async () => {
    const sheet = zip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(26 * 1024 * 1024) }]);
    await expect(parseFile(sheet, 's.xlsx')).rejects.toThrow(/too large when unpacked/);
    const total = zip([
      { name: 'xl/sharedStrings.xml', data: Buffer.alloc(20 * 1024 * 1024) },
      { name: 'xl/media/a.bin', data: Buffer.alloc(20 * 1024 * 1024) },
    ]);
    await expect(parseFile(total, 't.xlsx')).rejects.toThrow(/too large when unpacked/);
  });

  describe('crafted archives', () => {
    const small = (name: string) => ({ name, data: Buffer.from('<x/>') });
    const two = [small('a.xml'), small('b.xml')];

    it('rejects an end record that counts fewer entries than the directory holds', async () => {
      await expect(parseFile(zip(two, { entryCount: 1 }), 'a.xlsx')).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('rejects an end record that counts more entries than the directory holds', async () => {
      await expect(parseFile(zip(two, { entryCount: 5 }), 'a.xlsx')).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('rejects an extra central header after the declared directory', async () => {
      await expect(parseFile(zip(two, { extraCentral: true }), 'a.xlsx')).rejects.toThrow(
        /not a valid XLSX/,
      );
    });

    it('rejects a second end record hidden in the archive comment', async () => {
      const fake = Buffer.alloc(22);
      fake.writeUInt32LE(0x06054b50, 0);
      await expect(parseFile(zip(two, { comment: fake }), 'a.xlsx')).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('accepts a plain well-formed archive up to the workbook checks', async () => {
      // Well formed (guard passes) but not a workbook: still a ValidationError, from the reader.
      await expect(parseFile(zip(two), 'a.xlsx')).rejects.toBeInstanceOf(ValidationError);
    });
  });

  it('reads a realistic 20k-row workbook quickly', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['Date', 'Description', 'Amount', 'Balance']);
    for (let i = 0; i < 20_000; i += 1) {
      ws.addRow([
        new Date(Date.UTC(2026, 0, 1 + (i % 300))),
        `Merchant ${i}`,
        -(i % 500) - 0.5,
        100,
      ]);
    }
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const started = Date.now();
    const table = await parseFile(buf, 'big.xlsx');
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(table.rows).toHaveLength(20_000);
    expect(table.rows[0]).toEqual(['2026-01-01', 'Merchant 0', '-0.5', '100']);
  });

  it('rejects a sparse far-corner sheet quickly without exhausting memory', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = 'x';
    ws.getCell('XFD1048576').value = 'far';
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const before = process.memoryUsage().heapUsed;
    const started = Date.now();
    await expect(parseFile(buf, 'sparse.xlsx')).rejects.toBeInstanceOf(ValidationError);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(200 * 1024 * 1024);
  });

  it('rejects a sheet with more than the maximum number of rows', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['Date', 'Description', 'Amount']);
    for (let i = 0; i < MAX_IMPORT_ROWS; i += 1) ws.addRow(['2026-01-01', `r${i}`, 1]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await expect(parseFile(buf, 'rows.xlsx')).rejects.toThrow(/50000 rows/);
  }, 60_000);

  it('rejects a cell beyond column 200', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = 'x';
    ws.getCell(1, 201).value = 'y';
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await expect(parseFile(buf, 'cols.xlsx')).rejects.toThrow(/too many columns/);
  });

  it('rejects files that are not zip archives', async () => {
    await expect(parseFile(Buffer.from('not a zip'), 'x.xlsx')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  describe('canonical archive', () => {
    /** The parts of an exceljs-written workbook, ready to be re-zipped in any order. */
    async function parts(build: (ws: ExcelJS.Worksheet) => void, hide?: boolean) {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('S');
      if (hide) ws.state = 'hidden';
      build(ws);
      if (hide) {
        const visible = wb.addWorksheet('Visible');
        visible.addRow(['Date', 'Description', 'Amount']);
        visible.addRow([new Date(Date.UTC(2026, 3, 1)), 'Visible sheet', 7]);
      }
      const kept = assertSafeXlsxArchive(Buffer.from(await wb.xlsx.writeBuffer()));
      return [...kept].map(([name, data]) => ({ name, data }));
    }
    const datedSheet = (ws: ExcelJS.Worksheet) => {
      ws.addRow(['Date', 'Description', 'Amount']);
      ws.addRow([new Date(Date.UTC(2026, 2, 5)), 'Shop', -1.5]);
    };
    const rank = (order: string[]) => (n: string) => {
      const i = order.findIndex((k) => n.includes(k));
      return i < 0 ? order.length : i;
    };
    const reorder = (entries: Array<{ name: string; data: Buffer }>, order: string[]) =>
      [...entries].sort((x, y) => rank(order)(x.name) - rank(order)(y.name));
    const tmpFiles = () => readdirSync(tmpdir()).filter((f) => f.startsWith('tmp-'));

    it('reads dates as dates whatever the order of the entries (styles or workbook after the sheet)', async () => {
      const entries = await parts(datedSheet);
      for (const order of [
        ['worksheets/sheet', 'sharedStrings', 'styles', 'workbook.xml.rels', 'workbook.xml'],
        ['workbook.xml.rels', 'worksheets/sheet', 'workbook.xml', 'styles', 'sharedStrings'],
        ['styles', 'worksheets/sheet', 'workbook.xml'],
      ]) {
        const table = await parseFile(zip(reorder(entries, order)), 'o.xlsx');
        expect(table.rows).toEqual([['2026-03-05', 'Shop', '-1.5']]);
      }
    });

    it('leaves no temp files behind, after a parse or a rejected parse, even sheet-first', async () => {
      const before = tmpFiles();
      const sheetFirst = ['worksheets/sheet', 'sharedStrings', 'styles', 'workbook'];
      const ok = zip(reorder(await parts(datedSheet), sheetFirst));
      await parseFile(ok, 'ok.xlsx');
      const wide = await parts((ws) => {
        ws.getCell('A1').value = 'x';
        ws.getCell(1, 201).value = 'y';
      });
      await expect(parseFile(zip(reorder(wide, sheetFirst)), 'w.xlsx')).rejects.toBeInstanceOf(
        ValidationError,
      );
      expect(tmpFiles()).toEqual(before);
    });

    const withWorkbookXml = async (edit: (xml: string) => string) => {
      const entries = await parts(datedSheet);
      return zip(
        entries.map((e) =>
          e.name === 'xl/workbook.xml'
            ? { ...e, data: Buffer.from(edit(e.data.toString('utf8'))) }
            : e,
        ),
      );
    };

    it('does not scan workbook XML with regexes: pathological attributes finish fast', async () => {
      const cases: Array<{ edit: (xml: string) => string; valid: boolean }> = [
        { edit: (xml) => xml.replace('<sheet ', `<sheet ${'a-'.repeat(200_000)} `), valid: false },
        // A very long but well-formed attribute: the sheet must still be selected and read.
        {
          edit: (xml) => xml.replace('<sheet ', `<sheet x="${'a-'.repeat(500_000)}" `),
          valid: true,
        },
        {
          edit: (xml) => xml.replace('<sheet ', `<sheet ${'a:id'.repeat(100_000)} `),
          valid: false,
        },
      ];
      for (const { edit, valid } of cases) {
        const file = await withWorkbookXml(edit);
        const started = Date.now();
        const outcome = await parseFile(file, 'redos.xlsx').then(
          (table) => table,
          (error: unknown) => error,
        );
        expect(Date.now() - started).toBeLessThanOrEqual(1_000);
        if (valid)
          expect((outcome as { rows: string[][] }).rows).toEqual([['2026-03-05', 'Shop', '-1.5']]);
        else expect(outcome).toBeInstanceOf(ValidationError);
      }
      // Junk attributes are malformed XML: rejected, not skipped.
      await expect(
        parseFile(
          await withWorkbookXml((x) => x.replace('<sheet ', `<sheet ${'a-'.repeat(1_000)} `)),
          'm.xlsx',
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('accepts the Strict OOXML relationships namespace as well as the transitional one', async () => {
      const strict = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
      const file = await withWorkbookXml((xml) =>
        xml.replace('http://schemas.openxmlformats.org/officeDocument/2006/relationships', strict),
      );
      expect((await parseFile(file, 'strict.xlsx')).rows).toEqual([['2026-03-05', 'Shop', '-1.5']]);
    });

    it('finds the sheet through the relationships namespace under any prefix', async () => {
      const file = await withWorkbookXml((xml) =>
        xml.replace(/xmlns:r=/g, 'xmlns:q=').replace(/\br:id=/g, 'q:id='),
      );
      expect((await parseFile(file, 'p.xlsx')).rows).toEqual([['2026-03-05', 'Shop', '-1.5']]);
    });

    it('caps workbook.xml and the relationships part at 1 MiB', async () => {
      const big = await withWorkbookXml((xml) =>
        xml.replace('<sheet ', `<sheet x="${'a'.repeat(1_100_000)}" `),
      );
      await expect(parseFile(big, 'big.xlsx')).rejects.toThrow(/too large when unpacked/);
      const rels = (await parts(datedSheet)).map((e) =>
        e.name === 'xl/_rels/workbook.xml.rels'
          ? { ...e, data: Buffer.from(`<Relationships>${' '.repeat(1_100_000)}</Relationships>`) }
          : e,
      );
      await expect(parseFile(zip(rels), 'rels.xlsx')).rejects.toThrow(/too large when unpacked/);
    });

    it('reads the first visible sheet listed in the workbook, skipping hidden ones', async () => {
      const entries = await parts(datedSheet, true);
      const table = await parseFile(zip(entries), 'h.xlsx');
      expect(table.rows).toEqual([['2026-04-01', 'Visible sheet', '7']]);
    });

    it('rejects a hidden local entry before the first entry and between entries', async () => {
      const entries = await parts(datedSheet);
      await expect(parseFile(zip(entries, { hiddenBefore: true }), 'a.xlsx')).rejects.toThrow(
        ValidationError,
      );
      await expect(parseFile(zip(entries, { hiddenBetween: true }), 'a.xlsx')).rejects.toThrow(
        ValidationError,
      );
    });

    it('rejects local headers whose sizes disagree with the central record', async () => {
      const entries = await parts(datedSheet);
      await expect(parseFile(zip(entries, { localSizeShift: 5 }), 'a.xlsx')).rejects.toThrow(
        /size mismatch/,
      );
    });

    it('accepts data descriptors (sizes from the central record) and rejects encrypted entries', async () => {
      const entries = await parts(datedSheet);
      const table = await parseFile(zip(entries, { flags: 0x08 }), 'd.xlsx');
      expect(table.rows).toHaveLength(1);
      await expect(parseFile(zip(entries, { flags: 0x01 }), 'e.xlsx')).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('caps shared strings at 10 MiB and a single cell at 10,000 characters', async () => {
      const entries = await parts(datedSheet);
      const bloated = entries.map((e) =>
        e.name === 'xl/sharedStrings.xml'
          ? { ...e, data: Buffer.alloc(11 * 1024 * 1024, 0x20) }
          : e,
      );
      await expect(parseFile(zip(bloated), 'sst.xlsx')).rejects.toThrow(/too large when unpacked/);
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('S');
      ws.addRow(['Date', 'Description', 'Amount']);
      ws.addRow(['2026-01-01', 'x'.repeat(10_001), 1]);
      await expect(
        parseFile(Buffer.from(await wb.xlsx.writeBuffer()), 'cell.xlsx'),
      ).rejects.toThrow(/too much text/);
    });
  });
});

type ZipOpts = {
  entryCount?: number;
  extraCentral?: boolean;
  comment?: Buffer;
  /** A valid local entry with no central record, before the first entry / after it. */
  hiddenBefore?: boolean;
  hiddenBetween?: boolean;
  /** Added to the uncompressed size in local headers only. */
  localSizeShift?: number;
  /** General purpose flags for every entry (bit 3 makes the writer emit data descriptors). */
  flags?: number;
};

/** Minimal zip writer (deflate) so crafted archives need no archive library. */
function zip(
  entries: Array<{ name: string; data: Buffer; declaredSize?: number }>,
  opts: ZipOpts = {},
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const flags = opts.flags ?? 0;
  const descriptor = (flags & 0x08) !== 0;
  const hiddenEntry = () => {
    const data = Buffer.from('<hidden/>');
    const body = deflateRawSync(data);
    const name = Buffer.from('hidden.xml');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    offset += local.length + name.length + body.length;
  };
  if (opts.hiddenBefore) hiddenEntry();
  entries.forEach(({ name, data, declaredSize }, i) => {
    const body = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const declared = declaredSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    if (!descriptor) {
      local.writeUInt32LE(crc32(data), 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(declared + (opts.localSizeShift ?? 0), 22);
    }
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
    if (descriptor) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc32(data), 4);
      dd.writeUInt32LE(body.length, 8);
      dd.writeUInt32LE(declared, 12);
      locals.push(dd);
      offset += dd.length;
    }
    if (i === 0 && opts.hiddenBetween) hiddenEntry();
  });
  const cd = Buffer.concat(centrals);
  // A further central header placed after the range the end record declares.
  const hidden = opts.extraCentral ? Buffer.concat(centrals.slice(0, 2)) : Buffer.alloc(0);
  const comment = opts.comment ?? Buffer.alloc(0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(opts.entryCount ?? entries.length, 8);
  end.writeUInt16LE(opts.entryCount ?? entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cd, hidden, end, comment]);
}
