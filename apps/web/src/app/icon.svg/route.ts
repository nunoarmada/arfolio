import { getBrand } from '@/lib/brand';
import { faviconSvg } from '@/lib/brand-glyph';

export const dynamic = 'force-dynamic';

/** SVG favicon in the raw brand colour. One appearance for light and dark tabs (both clear 3:1). */
export function GET(): Response {
  return new Response(faviconSvg(getBrand().primaryHex), {
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' },
  });
}
