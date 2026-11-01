import { getBrand } from '@/lib/brand';
import { faviconEntries, renderPng } from '@/lib/brand-icons';
import { packIco } from '@/lib/ico';

export const dynamic = 'force-dynamic';

/** ICO favicon with 16, 32 and 48px PNG entries, generated from the brand config. */
export async function GET(): Promise<Response> {
  const images = await Promise.all(
    faviconEntries(getBrand().primaryHex).map(async ({ size, svg }) => ({
      size,
      png: await renderPng(svg, size),
    })),
  );
  const ico = packIco(images);
  return new Response(ico.buffer as ArrayBuffer, {
    headers: { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=3600' },
  });
}
