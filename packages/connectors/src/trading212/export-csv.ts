/** What the history CSV export says about one transaction (looked up by its `ID`). */
export type Trading212ExportRow = {
  action?: string;
  notes?: string;
  merchantName?: string;
  merchantCategory?: string;
};

export type Trading212ExportParse = {
  rows: Map<string, Trading212ExportRow>;
  /** An `ID` column plus at least one of `Merchant name` / `Notes` was found. */
  recognised: boolean;
  /** Header cells as written (column names only, never cell values), for diagnostics. */
  header: string[];
};

/** RFC 4180: quoted fields may hold commas, newlines and `""` escapes; CRLF or LF row ends. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Parses the Trading 212 history CSV into rows keyed by `ID` (the API's `reference`). Columns are
 * found by header name (case-insensitive, trimmed); a missing column simply yields no value. When
 * the header is not `recognised` the caller should not trust the result.
 */
export function parseTrading212ExportCsv(text: string): Trading212ExportParse {
  const result = new Map<string, Trading212ExportRow>();
  const [header, ...body] = parseCsv(text);
  if (header === undefined) return { rows: result, recognised: false, header: [] };
  const names = header.map((h) => h.trim().toLowerCase());
  const index = (name: string) => names.indexOf(name);
  const idCol = index('id');
  const columns = {
    action: index('action'),
    notes: index('notes'),
    merchantName: index('merchant name'),
    merchantCategory: index('merchant category'),
  } as const;
  const parsed: Trading212ExportParse = {
    rows: result,
    recognised: idCol >= 0 && (columns.merchantName >= 0 || columns.notes >= 0),
    header: header.map((h) => h.trim()),
  };
  if (idCol < 0) return parsed;
  for (const cells of body) {
    const id = cells[idCol]?.trim();
    if (id === undefined || id === '') continue;
    const entry: Trading212ExportRow = {};
    for (const key of Object.keys(columns) as (keyof typeof columns)[]) {
      const value = columns[key] < 0 ? undefined : cells[columns[key]]?.trim();
      if (value !== undefined && value !== '') entry[key] = value;
    }
    result.set(id, entry);
  }
  return parsed;
}
