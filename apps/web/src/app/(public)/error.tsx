'use client';

import { RouteError } from '@/components/route-error';

export default function PublicError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main
      id="main"
      tabIndex={-1}
      className="flex min-h-dvh items-start justify-center px-4 pt-12 outline-none md:items-center md:pt-0"
    >
      <RouteError onRetry={reset} />
    </main>
  );
}
