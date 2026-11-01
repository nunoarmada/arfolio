import type { ReactNode } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { LocaleSwitch } from '@/components/locale-switch';
import { getBrand } from '@/lib/brand';
import { cn } from '@/lib/cn';

/**
 * A rising line on a faint grid, drawn in the brand's primary: pure decoration for the auth panel
 * (no figures, no claims). Everything is a token, so it follows the installation's colour.
 */
function ChartMotif({ className }: { className?: string }) {
  const line =
    'M0 232 C 40 226 70 214 108 206 S 168 214 206 188 S 262 170 300 176 S 360 132 402 118 S 468 84 520 56 S 570 30 600 18';
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 600 260"
      preserveAspectRatio="none"
      className={className}
    >
      <defs>
        <linearGradient id="auth-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[52, 104, 156, 208].map((y) => (
        <line
          key={y}
          x1="0"
          x2="600"
          y1={y}
          y2={y}
          stroke="var(--chart-grid)"
          strokeWidth="1"
          strokeDasharray="2 4"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <path d={`${line} L600 260 L0 260 Z`} fill="url(#auth-area)" />
      <path
        d="M0 244 C 60 240 110 236 160 232 S 260 226 320 214 S 440 196 520 176 S 580 160 600 154"
        fill="none"
        stroke="var(--border-strong)"
        strokeWidth="1.5"
        strokeDasharray="5 5"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={line}
        fill="none"
        stroke="var(--primary)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * Full-page frame for sign-in, setup, invitations and 2FA: no navigation. From lg a split screen,
 * the brand panel (`--sidebar` with a brand glow, the lockup and a decorative chart line) on the
 * left and the form card on the right; below lg the brand mark sits centred above the card.
 */
export function AuthShell({
  children,
  width = 'sm',
}: {
  children: ReactNode;
  width?: 'sm' | 'md';
}) {
  const brand = getBrand();
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-2">
      <div className="relative hidden min-w-0 flex-col justify-between bg-sidebar p-10 shadow-[1px_0_0_var(--border)] lg:flex xl:p-14">
        {/* The single brand glow of the page: a wash from the top-left plus a soft gradient bloom. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(100%_80%_at_0%_0%,var(--primary-glow),transparent_72%),radial-gradient(70%_50%_at_100%_100%,var(--primary-glow),transparent_70%)]"
        />
        <ChartMotif className="pointer-events-none absolute inset-x-0 bottom-0 h-[42%] w-full" />
        <BrandMark brand={brand} size="lg" className="relative" />
      </div>
      <main
        id="main"
        tabIndex={-1}
        className="flex min-h-dvh min-w-0 flex-col items-center px-4 pb-8 pt-12 outline-none md:justify-center md:py-10"
      >
        <div className={cn('w-full', width === 'md' ? 'max-w-[520px]' : 'max-w-[400px]')}>
          <BrandMark brand={brand} size="lg" className="mb-6 justify-center lg:hidden" />
          <div className="rounded-xl bg-surface p-5 shadow-raised sm:p-6 md:p-8">{children}</div>
          <footer className="mt-6 flex justify-center">
            <LocaleSwitch />
          </footer>
        </div>
      </main>
    </div>
  );
}
