'use client';

import { cn } from '@/lib/cn';

/** A labelled on/off switch. The caller provides the accessible name via `aria-labelledby`. */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  ...aria
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  id?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
}) {
  return (
    <button
      {...aria}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-11 w-14 shrink-0 items-center justify-center rounded-full disabled:opacity-60',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'relative block h-7 w-12 rounded-full border transition-colors duration-[180ms] ease-out',
          checked ? 'border-primary bg-primary' : 'border-muted-foreground bg-surface-2',
        )}
      >
        <span
          className={cn(
            'absolute left-0.5 top-[3px] size-5 rounded-full shadow-[var(--shadow-sm)] transition-transform duration-[180ms] ease-out',
            checked ? 'bg-surface' : 'bg-muted-foreground',
            checked ? 'translate-x-5' : 'translate-x-0',
          )}
        />
      </span>
    </button>
  );
}
