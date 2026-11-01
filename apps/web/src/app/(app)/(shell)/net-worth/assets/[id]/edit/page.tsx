import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { AssetFormPage } from '../../../form-pages';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('asset.form'))('editTitle') };
}

export default async function EditAssetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return <AssetFormPage id={id} query={query} />;
}
