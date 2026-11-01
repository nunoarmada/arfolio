import type { ReactNode } from 'react';

/** One label/value line of a detail card; the label is the `dt`, the value the `dd`. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4 py-3">
      <dt className="max-w-[45%] shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right text-base [overflow-wrap:anywhere]">
        {children}
      </dd>
    </div>
  );
}
