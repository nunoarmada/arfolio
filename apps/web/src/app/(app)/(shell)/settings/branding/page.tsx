import { getLocale, getTranslations } from 'next-intl/server';
import { Palette } from 'lucide-react';
import type { Metadata } from 'next';
import { BrandMark } from '@/components/brand-mark';
import { PageHeader } from '@/components/page-header';
import { SettingsCard } from '@/components/settings/settings-card';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { getBrand } from '@/lib/brand';
import { BrandPreview } from './brand-preview';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('branding'))('title') };
}

export default async function BrandingPage() {
  const [t, settings, locale] = await Promise.all([
    getTranslations('branding'),
    getTranslations('settings'),
    getLocale(),
  ]);
  const brand = getBrand();
  const ratio = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  });
  const modes = (['light', 'dark'] as const).map((mode) => {
    const m = brand.tokens[mode];
    return {
      mode,
      label: t(mode),
      modeWord: t(mode === 'light' ? 'modeLight' : 'modeDark'),
      primary: m.primary,
      foreground: m.primaryForeground,
      hex: m.primaryHex,
      buttonText: t('buttonText', { ratio: ratio.format(m.contrast.buttonText) }),
      focusRing: t('focusRing', { ratio: ratio.format(m.contrast.ring) }),
      adjusted: m.adjusted
        ? t('adjusted', { mode: t(mode === 'light' ? 'modeLight' : 'modeDark') })
        : t('unchanged'),
    };
  });
  return (
    <>
      <PageHeader title={t('title')} backHref="/settings" backLabel={settings('back')} />
      <div className="grid grid-cols-1 gap-4 md:gap-5">
        <Alert tone="info">{t('readOnly')}</Alert>

        <Card as="dl" pad="md" className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="grid grid-cols-1 gap-1">
            <dt className="text-label text-muted-foreground">{t('productName')}</dt>
            <dd className="text-base font-medium">{brand.name}</dd>
          </div>
          <div className="grid grid-cols-1 gap-1">
            <dt className="text-label text-muted-foreground">{t('configured')}</dt>
            <dd className="flex items-center gap-2 text-base font-medium">
              <span
                aria-hidden="true"
                className="size-5 rounded-sm shadow-[0_0_0_1px_var(--border-strong)]"
                style={{ background: brand.primaryHex }}
              />
              <span className="tabular-nums">{brand.primaryHex}</span>
            </dd>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:col-span-2">
            <dt className="text-label text-muted-foreground">{t('logo')}</dt>
            <dd className="grid grid-cols-1 gap-2">
              <BrandMark brand={brand} size="lg" />
              {!brand.logoUrl ? (
                <p className="text-sm text-muted-foreground">{t('noLogo')}</p>
              ) : null}
            </dd>
          </div>
        </Card>

        <SettingsCard titleId="derived-title" title={t('derived')} icon={Palette}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {modes.map((m) => (
              <BrandPreview
                key={m.mode}
                mode={m.mode}
                title={t('previewLabel', { mode: m.modeWord })}
                primary={m.primary}
                foreground={m.foreground}
                hex={m.hex}
                buttonText={m.buttonText}
                focusRing={m.focusRing}
                adjusted={m.adjusted}
                labels={{
                  nav: t('previewNav'),
                  button: t('previewButton'),
                  chip: t('previewChip'),
                }}
              />
            ))}
          </div>
        </SettingsCard>
      </div>
    </>
  );
}
