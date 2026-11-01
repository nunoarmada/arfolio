/**
 * Class names for the app's data tables (design system v2, 4). A table is `border-separate
 * border-spacing-0` so sticky cells keep their borders; the header is 40px on surface-2, rows are
 * 44px (48 on coarse pointers) at 14px, numbers right-aligned and tabular, and totals carry a
 * stronger rule. Wrap it in `ScrollRegion`; where a column must truncate, use `table-fixed`, a
 * `<colgroup>` and put `dataTable.truncate` on an inner span. Money is never truncated.
 *
 *   <ScrollRegion label="…"><table className={dataTable.table}>…</table></ScrollRegion>
 */
export const dataTable = {
  table: 'w-full border-separate border-spacing-0 text-sm',
  /** Header cell. Sentence case, `label` style. */
  th: 'h-10 whitespace-nowrap border-b border-border bg-surface-2 px-3 text-left text-label font-medium text-muted-foreground first:pl-4 last:pr-4',
  thNum: 'text-right',
  /** Body cell: the border sits on the cell because rows cannot carry one under border-separate. */
  td: 'h-11 border-b border-border px-3 align-middle first:pl-4 last:pr-4 pointer-coarse:h-12 group-last/row:border-b-0',
  tdNum: 'text-right tabular-nums',
  row: 'group/row transition-colors hover:bg-surface-2',
  /** Totals row: heavier weight and a strong rule above. */
  totals: 'font-semibold [&>td]:border-t [&>td]:border-t-border-strong [&>td]:bg-surface',
  /** First column that stays while the table scrolls sideways; its right edge gains a shadow. */
  stickyFirst:
    'sticky left-0 z-10 bg-surface group-data-[start=false]/scroll:shadow-[1px_0_0_var(--border-strong),6px_0_8px_-6px_var(--edge-shadow)]',
  stickyFirstHead:
    'sticky left-0 z-10 bg-surface-2 group-data-[start=false]/scroll:shadow-[1px_0_0_var(--border-strong),6px_0_8px_-6px_var(--edge-shadow)]',
  /** On a span inside a `table-fixed` cell. */
  truncate: 'block truncate',
} as const;
