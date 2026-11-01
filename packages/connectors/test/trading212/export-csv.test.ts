import { describe, expect, it } from 'vitest';
import { parseTrading212ExportCsv } from '../../src/trading212/export-csv.js';

const BOM = String.fromCharCode(0xfeff);
const HEADER = 'Action,Time,ID,Notes,Total,Currency (Total),Merchant name,Merchant category';

describe('parseTrading212ExportCsv', () => {
  it('maps card rows by ID with merchant name and category', () => {
    const csv = [
      HEADER,
      'Card debit,2026-10-01 12:00:00,ref-1,,-4.50,EUR,Cafe Lisboa,Restaurants',
    ].join('\n');
    expect(parseTrading212ExportCsv(csv).rows.get('ref-1')).toEqual({
      action: 'Card debit',
      merchantName: 'Cafe Lisboa',
      merchantCategory: 'Restaurants',
    });
  });

  it('handles quoted commas, escaped quotes, CRLF and a BOM', () => {
    const csv = `${BOM}${HEADER}\r\n"Card debit","2026-10-01","ref-2","","-1","EUR","Smith, ""Joe"" & Sons","Shops"\r\n`;
    const map = parseTrading212ExportCsv(csv).rows;
    expect(map.get('ref-2')?.merchantName).toBe('Smith, "Joe" & Sons');
    expect(map.size).toBe(1);
  });

  it('keeps newlines inside quoted fields', () => {
    const csv = `${HEADER}\n"Deposit","t","ref-3","line one\nline two","1","EUR","",""\n`;
    expect(parseTrading212ExportCsv(csv).rows.get('ref-3')?.notes).toBe('line one\nline two');
  });

  it('matches headers case-insensitively and trimmed', () => {
    const csv = ' action , ID ,NOTES, merchant NAME \nCard debit,ref-4,hello,Shop\n';
    expect(parseTrading212ExportCsv(csv).rows.get('ref-4')).toEqual({
      action: 'Card debit',
      notes: 'hello',
      merchantName: 'Shop',
    });
  });

  it('omits empty fields and tolerates missing merchant columns', () => {
    const csv = 'Action,ID,Notes\nDeposit,ref-5,\nInterest,ref-6,Paid\n';
    const map = parseTrading212ExportCsv(csv).rows;
    expect(map.get('ref-5')).toEqual({ action: 'Deposit' });
    expect(map.get('ref-6')).toEqual({ action: 'Interest', notes: 'Paid' });
  });

  it('skips rows without an ID and returns an empty map without an ID column', () => {
    expect(parseTrading212ExportCsv('Action,ID\nDeposit,\n').rows.size).toBe(0);
    expect(parseTrading212ExportCsv('Action,Notes\nDeposit,x\n').rows.size).toBe(0);
    expect(parseTrading212ExportCsv('').rows.size).toBe(0);
  });

  it('recognises a header with an ID column and merchant name or notes', () => {
    expect(parseTrading212ExportCsv(`${HEADER}\n`).recognised).toBe(true);
    expect(parseTrading212ExportCsv('ID,Notes\n').recognised).toBe(true);
    expect(parseTrading212ExportCsv('id,merchant name\n').recognised).toBe(true);
  });

  it('does not recognise a header without ID or without merchant name and notes', () => {
    const noId = parseTrading212ExportCsv('Action,Notes,Merchant name\nx,y,z\n');
    expect(noId.recognised).toBe(false);
    expect(noId.header).toEqual(['Action', 'Notes', 'Merchant name']);
    expect(parseTrading212ExportCsv('Action,ID,Total\n').recognised).toBe(false);
    expect(parseTrading212ExportCsv('').recognised).toBe(false);
    expect(parseTrading212ExportCsv('').header).toEqual([]);
  });
});
