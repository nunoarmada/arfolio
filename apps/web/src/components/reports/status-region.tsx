'use client';

import { useState } from 'react';
import type { RowStatus } from '@/lib/reports';

/**
 * The one live region of a report page (and of the list). It says nothing on load. It announces
 * when a report becomes pending (the person asked for it), and when a pending one becomes ready or
 * failed. Focus never moves. It stays mounted across the refresh that swaps the page's content,
 * which is what lets a screen reader announce the change.
 */
export function ReportStatusRegion({
  status,
  messages,
}: {
  status: RowStatus;
  messages: { pending: string; ready: string; failed: string };
}) {
  const [seen, setSeen] = useState(status);
  const [text, setText] = useState('');
  if (seen !== status) {
    setSeen(status);
    setText(
      status === 'pending'
        ? messages.pending
        : seen === 'pending'
          ? status === 'ready'
            ? messages.ready
            : status === 'failed'
              ? messages.failed
              : ''
          : '',
    );
  }
  return (
    <div role="status" aria-atomic="true" className="sr-only">
      {text}
    </div>
  );
}
