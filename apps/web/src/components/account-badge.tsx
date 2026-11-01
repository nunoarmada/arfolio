'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';

export function monogram(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => Array.from(w)[0] ?? '');
  return letters.join('').toLocaleUpperCase();
}

/** A round monogram disc (the bank logo stand-in: logos are not loaded, see the CSP). */
export function Monogram({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-surface-3 text-base font-semibold text-foreground',
        className,
      )}
    >
      {monogram(name)}
    </span>
  );
}

/** Compact: a 20px monogram and the short name. Full: 40px monogram, name and type label. */
export function AccountBadge({
  name,
  type,
  variant = 'compact',
  className,
}: {
  name: string;
  type?: string;
  variant?: 'compact' | 'full';
  className?: string;
}) {
  const t = useTranslations('accounts.types');
  const full = variant === 'full';
  return (
    <span className={cn('flex max-w-full min-w-0 items-center gap-2', className)}>
      <span
        aria-hidden="true"
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full bg-surface-3 font-semibold text-foreground',
          full ? 'size-10 text-base' : 'size-5 text-[10px]',
        )}
      >
        {monogram(name)}
      </span>
      {full ? (
        <span className="grid grid-cols-1 min-w-0">
          <span className="truncate text-base font-medium" title={name}>
            {name}
          </span>
          {type ? <span className="truncate text-sm text-muted-foreground">{t(type)}</span> : null}
        </span>
      ) : (
        <span className="truncate text-sm" title={name}>
          {name}
        </span>
      )}
    </span>
  );
}
