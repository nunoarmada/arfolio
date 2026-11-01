/**
 * Which account each Património row of the spreadsheet import is linked to. A new row is linked
 * to the account of the same name unless told otherwise; a record that already exists keeps its
 * link. The wizard shows that outcome as the preselected choice and sends only what the person
 * changed (an explicit null unlinks, an absent key keeps the importer's default). The row key
 * comes from the preview (`linkKey`): it is never rebuilt here.
 */

export interface LinkRow {
  /** The row's key in `accountLinks`, as the preview gave it. */
  linkKey: string;
  /** The household account whose name equals the row's. */
  suggestedAccountId: string | null;
  /** The account the matched record is linked to now. */
  currentAccountId: string | null;
  /** The existing record committing would update. */
  match: string | null;
}

/** What the importer does for a row on its own ('' is "not linked"). */
export function importerDefault(row: LinkRow): string {
  return row.match ? (row.currentAccountId ?? '') : (row.suggestedAccountId ?? '');
}

/** The account id shown selected before the person chooses: the importer's own outcome. */
export const defaultSelection = importerDefault;

/** The links to send: only rows the person changed away from the default. */
export function buildAccountLinks(
  rows: LinkRow[],
  selection: Readonly<Record<string, string>>,
): Record<string, string | null> {
  const links: Record<string, string | null> = {};
  for (const row of rows) {
    const chosen = selection[row.linkKey];
    if (chosen === undefined || chosen === importerDefault(row)) continue;
    links[row.linkKey] = chosen === '' ? null : chosen;
  }
  return links;
}
