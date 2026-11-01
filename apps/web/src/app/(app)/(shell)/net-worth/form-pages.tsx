import { getLocale, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { AssetForm } from '@/components/net-worth/asset-form';
import { LiabilityForm } from '@/components/net-worth/liability-form';
import { PageHeader } from '@/components/page-header';
import { currencyOptions } from '@/lib/format';
import { safeNext } from '@/lib/safe-redirect';
import { loadAssetForm, loadLiabilityForm } from '@/server/net-worth-data';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';
import { PageContainer } from '@/components/page-container';

type Query = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Where Cancelar goes: `?back=` when it stays inside Património, else the page's own default. */
function backTarget(query: Query, fallback: string): string {
  const requested = safeNext(one(query.back), fallback);
  return requested === '/net-worth' || requested.startsWith('/net-worth/') ? requested : fallback;
}

/** The asset form's page, for a new asset or an existing one. Viewers get a 404. */
export async function AssetFormPage({ id, query }: { id?: string; query: Query }) {
  const [session, t, common, locale] = await Promise.all([
    requireMember(await headers(), { roles: ['owner', 'member'] }),
    getTranslations('asset.form'),
    getTranslations('common'),
    getLocale(),
  ]);
  const data = await loadAssetForm(toServiceCtx(session), id ?? null);
  const back = backTarget(query, id ? `/net-worth/assets/${id}` : '/net-worth');
  return (
    <PageContainer width="narrow">
      <PageHeader
        title={id ? t('editTitle') : t('newTitle')}
        description={data.asset?.name}
        backHref={back}
        backLabel={common('back')}
      />
      <AssetForm
        key={id ?? 'new'}
        data={data}
        defaultKind={one(query.kind) ?? 'real_estate'}
        currencies={currencyOptions(locale)}
        back={back}
      />
    </PageContainer>
  );
}

/** The liability form's page, for a new liability or an existing one. Viewers get a 404. */
export async function LiabilityFormPage({ id, query }: { id?: string; query: Query }) {
  const [session, t, common, locale] = await Promise.all([
    requireMember(await headers(), { roles: ['owner', 'member'] }),
    getTranslations('liability.form'),
    getTranslations('common'),
    getLocale(),
  ]);
  const data = await loadLiabilityForm(toServiceCtx(session), id ?? null);
  const back = backTarget(query, id ? `/net-worth/liabilities/${id}` : '/net-worth');
  return (
    <PageContainer width="narrow">
      <PageHeader
        title={id ? t('editTitle') : t('newTitle')}
        description={data.liability?.name}
        backHref={back}
        backLabel={common('back')}
      />
      <LiabilityForm
        key={id ?? 'new'}
        data={data}
        defaultKind={one(query.kind) ?? 'mortgage'}
        currencies={currencyOptions(locale)}
        back={back}
      />
    </PageContainer>
  );
}
