import { maskSvg } from '@/lib/brand-glyph';

export const dynamic = 'force-static';

/** Safari pinned-tab mask: the shape never changes; the colour comes from the `mask-icon` link. */
export function GET(): Response {
  return new Response(maskSvg(), {
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' },
  });
}
