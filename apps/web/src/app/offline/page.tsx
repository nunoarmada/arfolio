import { WifiOff } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { BrandMark } from '@/components/brand-mark';
import { getBrand } from '@/lib/brand';
import { OfflineRetry } from './offline-retry';

// Never a build-time page: the live brand and the locale cookie are read per request. It needs no
// session and reads no data. The service worker precaches it by URL (next.config.ts), so keep it
// free of redirects and auth checks.
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('offline');
  return { title: t('title') };
}

export default async function OfflinePage() {
  const t = await getTranslations('offline');
  const brand = getBrand();
  return (
    <main
      id="main"
      tabIndex={-1}
      data-testid="offline-page"
      className="flex min-h-dvh w-full flex-col items-center bg-background px-4 pb-8 pt-12 outline-none md:justify-center md:py-10"
    >
      <div className="w-full max-w-[400px]">
        {/* Inline mark only: a remote logo would not load offline. */}
        <BrandMark
          brand={{ name: brand.name, logoUrl: undefined }}
          size="lg"
          className="mb-6 justify-center"
        />
        <div className="rounded-xl bg-surface p-5 shadow-raised sm:p-6 md:p-8">
          <span
            aria-hidden="true"
            className="mb-4 flex size-10 items-center justify-center rounded-lg bg-primary-soft text-primary-text"
          >
            <WifiOff className="size-5" />
          </span>
          <h1 className="mb-2 text-title">{t('title')}</h1>
          <p className="mb-6 max-w-[52ch] text-sm text-muted-foreground">
            {t('body', { product: brand.name })}
          </p>
          <OfflineRetry />
        </div>
      </div>
    </main>
  );
}
