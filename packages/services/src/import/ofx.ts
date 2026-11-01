import type { IngestRow } from '../pipeline.js';
import { ValidationError } from '../context.js';
import { AmountParseError, DateParseError, parseAmount, parseDate } from '@arfolio/core';
import { decodeText } from './csv.js';
import type { OfxParse, ParsedRow } from './types.js';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** First value of each leaf tag; works for XML (closed tags) and SGML (tags closed by newline). */
function leafTags(block: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const m of block.matchAll(/<([A-Za-z0-9.]+)>([^<\r\n]*)/g)) {
    const name = m[1]!.toUpperCase();
    const value = decodeEntities(m[2]!.trim());
    if (value !== '' && !tags.has(name)) tags.set(name, value);
  }
  return tags;
}

function toRow(tags: Map<string, string>, line: number, currency: string): ParsedRow {
  try {
    const posted = /^(\d{4})(\d{2})(\d{2})/.exec(tags.get('DTPOSTED') ?? '');
    if (!posted) throw new DateParseError(tags.get('DTPOSTED'));
    const bookingDate = parseDate(`${posted[1]}-${posted[2]}-${posted[3]}`, 'YMD');
    const rawAmount = tags.get('TRNAMT');
    if (rawAmount === undefined) throw new AmountParseError('');
    const amount = parseAmount(rawAmount, {
      decimal: rawAmount.includes(',') && !rawAmount.includes('.') ? ',' : '.',
    });
    const name = tags.get('NAME');
    const memo = tags.get('MEMO');
    const description = [name, memo && memo !== name ? memo : undefined].filter(Boolean).join(' ');
    if (!description) return { line, status: 'error', error: 'Missing description' };
    const row: IngestRow = {
      bookingDate,
      amount,
      currency,
      description: description.slice(0, 1_000),
    };
    const fitId = tags.get('FITID');
    if (fitId) {
      if (fitId.length > 200) return { line, status: 'error', error: 'FITID is too long' };
      row.externalId = fitId;
    }
    return { line, status: 'ok', row };
  } catch (error) {
    return {
      line,
      status: 'error',
      error: error instanceof Error ? error.message : 'Invalid transaction',
    };
  }
}

/** Parses OFX 1.x (SGML) and 2.x (XML) statements into normalised rows (FITID is the external id). */
export function parseOfx(buf: Buffer): OfxParse {
  const text = decodeText(buf);
  const blocks = [
    ...text.matchAll(
      /<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>|<\/CCSTMTRS>|<\/STMTRS>|$)/gi,
    ),
  ];
  if (blocks.length === 0) {
    throw new ValidationError('No statement transactions were found in the OFX file');
  }
  if ((text.match(/<(?:CC)?STMTRS>/gi) ?? []).length > 1) {
    throw new ValidationError('The OFX file holds multiple statements: import them one at a time');
  }
  const currency = /<CURDEF>\s*([A-Za-z]{3})/i.exec(text)?.[1]?.toUpperCase();
  return {
    ...(currency ? { currency } : {}),
    // Without CURDEF the rows carry a placeholder: the import service substitutes the account's.
    rows: blocks.map((block, i) => toRow(leafTags(block[1]!), i + 1, currency ?? 'XXX')),
  };
}
