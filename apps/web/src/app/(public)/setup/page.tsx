import { getLocale, getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { AuthShell } from '@/components/auth-shell';
import { currencyOptions, monthOptions, timeZoneOptions } from '@/lib/format';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@/lib/credentials';
import { isSetupOpen, isValidSetupToken } from '@/server/setup';
import { SetupForm } from './setup-form';

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: (await getTranslations('setup'))('title'),
    // The URL may carry the setup token: never leak it through Referer (proxy.ts sends the header too).
    referrer: 'no-referrer',
  };
}

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  // Once any account exists this route disappears.
  if (!(await isSetupOpen())) notFound();
  const [locale, t, params] = await Promise.all([
    getLocale(),
    getTranslations('setup'),
    searchParams,
  ]);
  const given = Array.isArray(params.token) ? params.token[0] : params.token;
  const tokenFromUrl = isValidSetupToken(given) ? (given ?? '') : '';
  return (
    <AuthShell width="md">
      <h1 className="text-title">{t('title')}</h1>
      <p className="mb-5 mt-1 text-base text-muted-foreground">{t('intro')}</p>
      <SetupForm
        defaultToken={tokenFromUrl}
        defaultLocale={locale}
        currencies={currencyOptions(locale)}
        months={monthOptions(locale)}
        timeZones={timeZoneOptions('UTC')}
        passwordBounds={{ min: MIN_PASSWORD_LENGTH, max: MAX_PASSWORD_LENGTH }}
      />
    </AuthShell>
  );
}
