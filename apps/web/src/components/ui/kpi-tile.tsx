import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Card, IconTile } from './card';

export type DeltaTone = 'positive' | 'neutral' | 'negative';

const DELTA: Record<DeltaTone, string> = {
  // Favourable: the soft green. Unfavourable but fine: calm grey. Only a real problem is red.
  positive: 'bg-positive-soft text-positive',
  neutral: 'bg-surface-2 text-muted-foreground',
  negative: 'bg-negative-soft text-negative',
};

/**
 * The change chip of a KPI: arrow, signed amount, optionally a percentage. `sr` is read before the
 * text ("Subiu", "Desceu") because an arrow and a colour are not a reliable signal on their own.
 */
export function DeltaChip({
  tone,
  icon: Icon,
  children,
  sr,
  className,
}: {
  tone: DeltaTone;
  icon?: LucideIcon;
  children: ReactNode;
  sr?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex min-h-[22px] max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-caption font-semibold tabular-nums max-sm:whitespace-normal sm:whitespace-nowrap sm:py-0',
        DELTA[tone],
        className,
      )}
    >
      {Icon ? <Icon className="size-3.5 shrink-0" aria-hidden="true" /> : null}
      {sr ? <span className="sr-only">{sr} </span> : null}
      {children}
    </span>
  );
}

/**
 * One number that answers one question: a 28px icon tile and a label, the value in the `kpi` size,
 * a delta chip with its comparison, and an optional footer (a sparkline or a progress bar). With
 * `href` the whole tile is a link, through the label (one link, so one tab stop and a short name).
 * `hero` adds the brand glow; use it for at most one tile per page.
 */
export function KpiTile({
  label,
  icon,
  value,
  delta,
  comparison,
  footer,
  href,
  hero = false,
  testId,
  className,
}: {
  label: string;
  icon: LucideIcon;
  value: ReactNode;
  delta?: ReactNode;
  comparison?: ReactNode;
  footer?: ReactNode;
  href?: string;
  hero?: boolean;
  testId?: string;
  className?: string;
}) {
  const text = (
    <span className="inline-flex min-h-7 items-center text-label text-muted-foreground">
      {label}
    </span>
  );
  return (
    <Card
      data-testid={testId}
      variant={hero ? 'hero' : href ? 'interactive' : 'default'}
      pad="sm"
      className={cn(
        'flex h-full min-w-0 flex-col gap-2 md:gap-2.5 md:p-4 xl:p-5',
        // In a KPI row the hero keeps the same radius as its siblings; the hairline follows it.
        hero && 'rounded-lg',
        href &&
          'has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-ring',
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <IconTile icon={icon} />
        {href ? (
          <Link
            href={href}
            className="min-w-0 outline-none after:absolute after:inset-0 after:rounded-[inherit]"
          >
            {text}
          </Link>
        ) : (
          text
        )}
      </div>
      <div className="min-w-0">{value}</div>
      {delta || comparison ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {delta}
          {comparison ? (
            <span className="text-label font-normal text-muted-foreground">{comparison}</span>
          ) : null}
        </div>
      ) : null}
      {footer ? <div className="mt-auto pt-1.5">{footer}</div> : null}
    </Card>
  );
}
