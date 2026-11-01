import type { MetadataRoute } from 'next';
import { BACKGROUND_HEX, getBrand } from '@/lib/brand';
import { isLocale, FALLBACK_LOCALE } from '@/i18n/locales';

export const dynamic = 'force-dynamic';

export default function manifest(): MetadataRoute.Manifest {
  const brand = getBrand();
  const lang = isLocale(process.env.DEFAULT_LOCALE) ? process.env.DEFAULT_LOCALE : FALLBACK_LOCALE;
  return {
    id: '/',
    name: brand.name,
    short_name: Array.from(brand.name).slice(0, 12).join(''),
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    lang,
    background_color: BACKGROUND_HEX.light,
    theme_color: BACKGROUND_HEX.light,
    icons: [
      { src: '/icons/192', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/512', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
