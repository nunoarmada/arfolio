import { useId, type ReactNode } from 'react';
import { AreaGradient, CHART_GRID } from '@/components/charts/chart-primitives';
import type { SparklineGeometry } from '@/lib/sparkline';
import { cn } from '@/lib/cn';

const points = (run: ReadonlyArray<{ x: number; y: number }>): string =>
  run.map((p) => `${p.x},${p.y}`).join(' ');

/** A mark placed by percent of the frame, so it stays round however wide the frame is. */
function Dot({ x, y, hollow = false }: { x: number; y: number; hollow?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={
        hollow
          ? 'absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-surface'
          : 'absolute size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/60'
      }
      style={{ left: `${x}%`, top: `${y}%` }}
    />
  );
}

/**
 * The shape of net worth over the last months: one 2px brand line, drawn in a 0..100 box stretched
 * to the frame (the stroke stays 2px), so it shrinks with its card; the end dot is a positioned
 * element because a stretched circle would turn into an ellipse. `area` adds the gradient fill
 * (`--primary-glow` to nothing) and `grid` the dashed guide lines of the chart variant. Hidden from
 * assistive technology: the caption says where the line starts and ends, and the card link leads
 * to the full chart.
 */
export function Sparkline({
  geometry,
  caption,
  area = false,
  grid = false,
  testId,
  className,
}: {
  geometry: SparklineGeometry;
  caption: ReactNode;
  area?: boolean;
  grid?: boolean;
  testId?: string;
  /** Sets the height of the plot (default 48px, 56 from md). */
  className?: string;
}) {
  const gradient = useId();
  const stroke = {
    fill: 'none',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    vectorEffect: 'non-scaling-stroke' as const,
  };
  return (
    <figure data-testid={testId} className="grid grid-cols-1 gap-1">
      <div className={cn('relative h-12 min-w-0 md:h-14', className)}>
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 size-full overflow-visible"
        >
          {area ? (
            <defs>
              <AreaGradient id={gradient} />
            </defs>
          ) : null}
          {grid
            ? [0, 50, 100].map((y) => (
                <line key={y} x1="0" x2="100" y1={y} y2={y} {...CHART_GRID} />
              ))
            : null}
          {area
            ? geometry.solid.map((run) => (
                <polygon
                  key={`a${run[0]!.x}`}
                  points={`${points(run)} ${run.at(-1)!.x},100 ${run[0]!.x},100`}
                  fill={`url(#${gradient})`}
                />
              ))
            : null}
          {area && geometry.dashed ? (
            <polygon
              points={`${points(geometry.dashed)} ${geometry.dashed[1].x},100 ${geometry.dashed[0].x},100`}
              fill={`url(#${gradient})`}
              opacity={0.5}
            />
          ) : null}
          {geometry.solid.map((run) => (
            <polyline key={run[0]!.x} points={points(run)} className="stroke-primary" {...stroke} />
          ))}
          {geometry.dashed ? (
            <polyline
              points={points(geometry.dashed)}
              className="stroke-primary"
              strokeDasharray="4 4"
              {...stroke}
            />
          ) : null}
        </svg>
        {geometry.dots.map((d) => (
          <Dot key={d.x} x={d.x} y={d.y} />
        ))}
        {geometry.end ? <Dot x={geometry.end.x} y={geometry.end.y} hollow /> : null}
      </div>
      <figcaption className="sr-only">{caption}</figcaption>
    </figure>
  );
}
