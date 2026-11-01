import { cn } from '@/lib/cn';

/** Placeholder that fades in only after 200ms (see .skeleton in globals.css). */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('skeleton', className)} />;
}
