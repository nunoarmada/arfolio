import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** A native checkbox in a 44px-high label, so the whole line is the target. */
export function Checkbox({
  label,
  hint,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className={cn('flex min-h-11 cursor-pointer items-start gap-3 py-2', className)}>
      <input
        type="checkbox"
        className="mt-0.5 size-5 shrink-0 cursor-pointer accent-[var(--primary)] disabled:cursor-not-allowed"
        {...props}
      />
      <span className="grid grid-cols-1 gap-0.5">
        <span className="text-base text-foreground">{label}</span>
        {hint ? <span className="text-sm text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}
