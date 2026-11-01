import { cn } from '@/lib/cn';
import type { Brand } from '@/lib/brand';
import { GLYPH_24, GLYPH_SCALE } from '@/lib/brand-glyph';

/**
 * Installation logo with the live product name beside it (the wordmark is text, so it follows
 * BRAND_NAME). Without BRAND_LOGO_URL the arch mark sits on a tile in the (derived) brand
 * gradient, drawn from the light-mode tokens in both themes (the mark is identity, not theme). The mark is decorative: the name next to it names it.
 */
export function BrandMark({
  brand,
  size = 'md',
  showName = true,
  className,
}: {
  brand: Pick<Brand, 'name' | 'logoUrl'>;
  size?: 'md' | 'lg';
  showName?: boolean;
  className?: string;
}) {
  const lg = size === 'lg';
  const box = lg ? 'size-12' : 'size-8';
  return (
    <div className={cn('flex min-w-0 items-center', lg ? 'gap-4' : 'gap-3', className)}>
      {brand.logoUrl ? (
        <img src={brand.logoUrl} alt="" className={cn('shrink-0 object-contain', box)} />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            'flex shrink-0 items-center justify-center bg-[image:linear-gradient(135deg,var(--brand-tile),var(--brand-tile-2))] text-[color:var(--brand-tile-foreground)] shadow-[inset_0_1px_0_oklch(1_0_0/0.18)]',
            lg ? 'rounded-[10px]' : 'rounded-[8px]',
            box,
          )}
        >
          <svg
            viewBox={`0 0 ${GLYPH_24.size} ${GLYPH_24.size}`}
            style={{ width: `${GLYPH_SCALE.ui * 100}%`, height: `${GLYPH_SCALE.ui * 100}%` }}
            focusable="false"
          >
            <path fill="currentColor" d={GLYPH_24.path} />
          </svg>
        </span>
      )}
      <span
        title={showName ? brand.name : undefined}
        className={cn(
          // The large mark (auth, branding) wraps long names to two balanced lines; the shell's
          // compact mark keeps one truncated line and carries the full name in `title`.
          lg
            ? 'line-clamp-2 text-balance break-words text-xl font-semibold tracking-[-0.01em] text-foreground'
            : 'truncate text-base font-semibold tracking-[-0.01em] text-foreground',
          !showName && 'sr-only',
        )}
      >
        {brand.name}
      </span>
    </div>
  );
}
