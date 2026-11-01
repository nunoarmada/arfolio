export class DateParseError extends Error {
  constructor(input: unknown) {
    super(`Cannot parse date: ${String(input)}`);
    this.name = 'DateParseError';
  }
}

export type DateFormat = 'DMY' | 'YMD' | 'MDY' | 'auto';

function iso(y: number, m: number, d: number, input: unknown): string {
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new DateParseError(input);
  }
  return [String(y).padStart(4, '0'), String(m).padStart(2, '0'), String(d).padStart(2, '0')].join(
    '-',
  );
}

/**
 * Parses `d/m/y`-style text with `/`, `-` or `.` separators into `YYYY-MM-DD`.
 * Two-digit years become 20yy. `auto` means YMD when the first part has four
 * digits, otherwise DMY.
 */
export function parseDate(input: string, format: DateFormat): string {
  const parts = input.trim().split(/[/.-]/);
  if (parts.length !== 3 || !parts.every((p) => /^\d{1,4}$/.test(p)))
    throw new DateParseError(input);

  const resolved: Exclude<DateFormat, 'auto'> =
    format === 'auto' ? (parts[0]!.length === 4 ? 'YMD' : 'DMY') : format;
  const [a, b, c] = parts.map(Number) as [number, number, number];
  const [rawYear, month, day] =
    resolved === 'YMD' ? [a, b, c] : resolved === 'MDY' ? [c, a, b] : [c, b, a];
  const yearText = resolved === 'YMD' ? parts[0]! : parts[2]!;
  const year = yearText.length <= 2 ? 2000 + rawYear : rawYear;
  return iso(year, month, day, input);
}

const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

/** Accepts strings, Excel serial numbers and Date objects (read via UTC components). */
export function parseDateValue(v: unknown, format: DateFormat): string {
  if (typeof v === 'string') return parseDate(v, format);
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 1) throw new DateParseError(v);
    const d = new Date(EXCEL_EPOCH_UTC + Math.floor(v) * MS_PER_DAY);
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), v);
  }
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new DateParseError(v);
    return iso(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate(), v);
  }
  throw new DateParseError(v);
}
