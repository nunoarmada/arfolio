import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Styling shared by the app's custom SVG charts (design system v2, 4): 1px dashed `--chart-grid`
 * guides, 12px muted tabular axis text, the household's own series as a 2px `--primary` line over
 * an area that fades from `--primary-glow` to nothing, and a raised tooltip card.
 */

/** Spread on a `<line>` that draws a guide. */
export const CHART_GRID = {
  className: 'stroke-chart-grid',
  strokeWidth: 1,
  strokeDasharray: '2 3',
  vectorEffect: 'non-scaling-stroke',
} as const;

/** Class of axis text (`<text fontSize={12}>`). */
export const CHART_AXIS_TEXT = 'fill-muted-foreground tabular-nums';

/** The household's own series: the brand line. Spread on a `<polyline>`. */
export const CHART_SERIES = {
  className: 'stroke-primary',
  strokeWidth: 2,
  strokeLinejoin: 'round',
  strokeLinecap: 'round',
  fill: 'none',
} as const;

/**
 * The area gradient, for `<defs>`; fill the area with `url(#id)`. The brand colour fading to
 * nothing is `--primary-glow`'s idea, expressed as stop opacities so it follows light and dark.
 */
export function AreaGradient({
  id,
  strength = 0.28,
  color = 'var(--primary)',
}: {
  id: string;
  strength?: number;
  /** Any CSS colour; defaults to the brand. Pass a series token for a second or third series. */
  color?: string;
}) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor={color} stopOpacity={strength} />
      <stop offset="100%" stopColor={color} stopOpacity={0} />
    </linearGradient>
  );
}

/** The hover/focus tooltip: a raised card, 13px, tabular. Position it with `style`. */
export function ChartTooltip({
  title,
  children,
  className,
  style,
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      role="presentation"
      style={style}
      className={cn(
        'pointer-events-none absolute z-10 min-w-32 rounded-md bg-surface-raised px-3 py-2 text-[13px] leading-[18px] tabular-nums shadow-raised',
        className,
      )}
    >
      {title ? <p className="mb-0.5 font-semibold">{title}</p> : null}
      <div className="text-muted-foreground">{children}</div>
    </div>
  );
}
