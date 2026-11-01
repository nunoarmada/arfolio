import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import localFont from 'next/font/local';
import { headers } from 'next/headers';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { CspNonce } from '@/components/csp-nonce';
import { ThemeProvider } from '@/components/theme-provider';
import { ToastProvider } from '@/components/ui/toast';
import { BACKGROUND_HEX, getBrand } from '@/lib/brand';
import { getEnv } from '@/lib/env';
import './globals.css';

// Geist Variable (weight axis), self-hosted from the fontsource package so the app makes no
// third-party requests. Latin covers Portuguese and English including "€". Its tabular figures
// (`tabular-nums`) give equal-width digits for money columns (design system v2 §3.1).
const geist = localFont({
  src: '../../node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2',
  weight: '100 900',
  variable: '--font-geist',
  display: 'swap',
});

export async function generateMetadata(): Promise<Metadata> {
  const brand = getBrand();
  const lang = `?lang=${await getLocale()}`;
  return {
    // Absolute base for the Open Graph and Twitter image URLs.
    metadataBase: new URL(getEnv().APP_URL),
    title: { default: brand.name, template: `%s · ${brand.name}` },
    applicationName: brand.name,
    // Every icon is generated at runtime from the brand config (see lib/brand-glyph.ts).
    icons: {
      icon: [
        { url: '/icon.svg', type: 'image/svg+xml' },
        { url: '/favicon.ico', sizes: '48x48' },
      ],
      apple: { url: '/icons/apple', sizes: '180x180', type: 'image/png' },
      other: [{ rel: 'mask-icon', url: '/icons/mask.svg', color: brand.primaryHex }],
    },
    openGraph: {
      type: 'website',
      siteName: brand.name,
      title: brand.name,
      images: [{ url: `/og${lang}`, width: 1200, height: 630, alt: brand.name }],
    },
    twitter: {
      card: 'summary_large_image',
      title: brand.name,
      images: [{ url: `/og/twitter${lang}`, width: 1200, height: 600, alt: brand.name }],
    },
    appleWebApp: { capable: true, title: brand.name, statusBarStyle: 'default' },
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: BACKGROUND_HEX.light },
    { media: '(prefers-color-scheme: dark)', color: BACKGROUND_HEX.dark },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, t, h] = await Promise.all([getLocale(), getTranslations('shell'), headers()]);
  const nonce = h.get('x-nonce') ?? undefined;
  const brand = getBrand();
  return (
    <html lang={locale} className={geist.variable} suppressHydrationWarning>
      <head>
        {/* Brand-derived --primary* tokens for both colour modes (design system §2.2). */}
        <style
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: brand.tokens.css }}
        />
      </head>
      <body>
        <CspNonce nonce={nonce} />
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded-md focus:bg-surface focus:px-4 focus:py-3 focus:text-base focus:font-medium focus:shadow-[var(--shadow-md)]"
        >
          {t('skipToContent')}
        </a>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem nonce={nonce}>
          <NextIntlClientProvider>
            <ToastProvider>{children}</ToastProvider>
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
