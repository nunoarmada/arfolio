'use client';

import { RouteError } from '@/components/route-error';

export default function ShellError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="py-6 md:py-12">
      <RouteError onRetry={reset} />
    </div>
  );
}
