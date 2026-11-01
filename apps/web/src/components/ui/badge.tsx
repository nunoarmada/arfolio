import type { ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

/** A count (nav, bell): solid brand, 20px, tabular. Counts are neutral news, never amber. */
export function CountBadge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold leading-none tabular-nums text-primary-foreground',
        className,
      )}
    >
      {children}
    </span>
  );
}

const chip = cva(
  'inline-flex h-[22px] min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-caption font-medium',
  {
    variants: {
      tone: {
        neutral: 'bg-surface-2 text-muted-foreground',
        positive: 'bg-positive-soft text-positive',
        warning: 'bg-warning-soft text-warning',
        negative: 'bg-negative-soft text-negative',
        primary: 'bg-primary-soft text-primary-text',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

const DOT: Record<NonNullable<VariantProps<typeof chip>['tone']>, string> = {
  neutral: 'bg-muted-foreground',
  positive: 'bg-positive',
  warning: 'bg-warning',
  negative: 'bg-negative',
  primary: 'bg-primary',
};

/**
 * A status chip: soft fill, a 6px dot and a text label. The label is the status; the dot and the
 * tone repeat it. `icon` replaces the dot where a glyph says it better (a check, an arrow).
 */
export function StatusChip({
  tone,
  icon,
  children,
  className,
}: VariantProps<typeof chip> & {
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn(chip({ tone }), className)}>
      {icon ?? (
        <span
          aria-hidden="true"
          className={cn('size-1.5 shrink-0 rounded-full', DOT[tone ?? 'neutral'])}
        />
      )}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

/** A filter chip: 40px on phones, 36px from md. Selected = soft strong brand fill and border. */
export function filterChipClass(selected: boolean): string {
  return cn(
    'inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-sm font-medium transition-colors duration-[120ms] md:h-9',
    selected
      ? 'bg-primary-soft-strong text-primary-text shadow-[inset_0_0_0_1px_var(--primary-border)]'
      : 'bg-surface text-foreground shadow-[inset_0_0_0_1px_var(--border-strong)] hover:bg-surface-2',
  );
}
