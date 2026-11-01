import { cn } from '@/lib/cn';

/** Surfaces and text from the design tokens, per mode, so the preview does not follow the page theme. */
const PALETTE = {
  light: {
    bg: 'oklch(0.972 0.003 260)',
    surface: 'oklch(1 0 0)',
    fg: 'oklch(0.20 0.012 260)',
    muted: 'oklch(0.48 0.012 260)',
    border: 'oklch(0.915 0.004 260)',
    track: 'oklch(0.93 0.005 260)',
    soft: 12,
  },
  dark: {
    bg: 'oklch(0.145 0.006 260)',
    surface: 'oklch(0.19 0.007 260)',
    fg: 'oklch(0.965 0.003 260)',
    muted: 'oklch(0.73 0.01 260)',
    border: 'oklch(0.28 0.008 260)',
    track: 'oklch(0.265 0.009 260)',
    soft: 18,
  },
} as const;

/** A mini shell (active nav item, primary button, focus ring, chip, progress bar) in the derived tokens. */
export function BrandPreview({
  mode,
  title,
  primary,
  foreground,
  hex,
  buttonText,
  focusRing,
  adjusted,
  labels,
}: {
  mode: 'light' | 'dark';
  title: string;
  primary: string;
  foreground: string;
  hex: string;
  buttonText: string;
  focusRing: string;
  adjusted: string;
  labels: { nav: string; button: string; chip: string };
}) {
  const p = PALETTE[mode];
  const vars = {
    '--pv-bg': p.bg,
    '--pv-surface': p.surface,
    '--pv-fg': p.fg,
    '--pv-muted': p.muted,
    '--pv-border': p.border,
    '--pv-track': p.track,
    '--pv-primary': primary,
    '--pv-primary-fg': foreground,
    '--pv-soft': `color-mix(in oklab, ${primary} ${p.soft}%, ${p.surface})`,
  } as React.CSSProperties;
  return (
    <figure className="grid grid-cols-1 gap-2">
      <div
        role="img"
        aria-label={title}
        style={vars}
        className="grid grid-cols-1 gap-3 rounded-xl bg-[var(--pv-bg)] p-4 shadow-[0_0_0_1px_var(--pv-border)] text-[var(--pv-fg)]"
      >
        <div className="flex h-11 items-center rounded-md bg-[var(--pv-soft)] px-3 text-base font-medium text-[var(--pv-primary)]">
          {labels.nav}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex h-11 items-center rounded-md bg-[var(--pv-primary)] px-4 text-base font-medium text-[var(--pv-primary-fg)]">
            {labels.button}
          </span>
          <span className="inline-flex h-11 items-center rounded-md bg-[var(--pv-surface)] px-4 shadow-[0_0_0_1px_var(--pv-border)] text-base outline outline-2 outline-offset-2 outline-[var(--pv-primary)]">
            {labels.chip}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-[var(--pv-track)]">
          <div className="h-full w-2/3 rounded-full bg-[var(--pv-primary)]" />
        </div>
      </div>
      <figcaption className={cn('grid grid-cols-1 gap-0.5 text-sm text-muted-foreground')}>
        <span className="font-medium text-foreground">{title}</span>
        <span className="tabular-nums">{hex}</span>
        <span className="tabular-nums">
          {buttonText}, {focusRing}
        </span>
        <span>{adjusted}</span>
      </figcaption>
    </figure>
  );
}
