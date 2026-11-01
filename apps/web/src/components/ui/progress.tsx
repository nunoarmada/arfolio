import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type ProgressTone = 'primary' | 'warning' | 'negative' | 'positive' | 'neutral';

const FILL: Record<ProgressTone, string> = {
  primary: 'bg-primary',
  warning: 'bg-warning',
  negative: 'bg-negative',
  positive: 'bg-positive',
  // The settled state ("Pago"): full and calm, a softened positive so it is plainly "met" without
  // being the heaviest bar on the page (~3:1 against the track in light, well above it in dark).
  neutral: 'bg-positive/70',
};

/**
 * A meter, 8px (6px `compact`) with a surface-3 track. The fill takes its tone from the caller:
 * brand while on track, positive for income received, warning from 90% of the plan, negative once
 * over (fill 100% plus a hatched cap at the right end) and neutral once exactly met. An optional
 * pace tick (2px) marks how far through the month today is. Colour never carries the status
 * alone: callers pair it with a sentence and a full `valueText`.
 */
export function Progress({
  fill,
  tone = 'primary',
  hatch = 0,
  pace = null,
  paceCaption,
  compact = false,
  label,
  valueNow,
  valueText,
  className,
}: {
  /** Share of the track the fill covers, 0..1. */
  fill: number;
  tone?: ProgressTone;
  /** Share of the track (right end) drawn as the over-spending hatch, 0..1. */
  hatch?: number;
  /** Where the pace tick sits, 0..1; null draws none. */
  pace?: number | null;
  /** Small caption under the tick ("Hoje"). */
  paceCaption?: ReactNode;
  compact?: boolean;
  /** The accessible name. */
  label: string;
  /** 0..100 */
  valueNow: number;
  valueText: string;
  className?: string;
}) {
  const clamped = Math.min(Math.max(fill, 0), 1);
  const captionAt: CSSProperties | undefined =
    pace !== null ? { left: `${Math.min(Math.max(pace, 0.06), 0.94) * 100}%` } : undefined;
  return (
    <div className={cn('w-full', paceCaption && pace !== null && 'pb-6', 'relative', className)}>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(Math.max(valueNow, 0), 100)}
        aria-valuetext={valueText}
        className={cn('relative w-full rounded-full bg-surface-3', compact ? 'h-1.5' : 'h-2')}
      >
        <div
          className={cn(
            'absolute inset-y-0 left-0 rounded-full transition-[width,background-color] duration-[260ms] ease-out motion-reduce:transition-none',
            FILL[tone],
          )}
          style={{ width: `${clamped * 100}%` }}
        />
        {hatch > 0 ? (
          <div
            className="absolute inset-y-0 right-0 rounded-full bg-[repeating-linear-gradient(45deg,var(--negative)_0_4px,var(--negative-soft)_4px_8px)]"
            style={{ width: `${hatch * 100}%` }}
          />
        ) : null}
        {pace !== null ? (
          <div
            aria-hidden="true"
            className={cn(
              'absolute top-1/2 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/60 ring-1 ring-surface',
              compact ? 'h-3' : 'h-3.5',
            )}
            style={{ left: `${pace * 100}%` }}
          />
        ) : null}
      </div>
      {paceCaption && pace !== null ? (
        <span
          aria-hidden="true"
          className="absolute top-full mt-1.5 -translate-x-1/2 whitespace-nowrap text-caption text-muted-foreground"
          style={captionAt}
        >
          {paceCaption}
        </span>
      ) : null}
    </div>
  );
}
