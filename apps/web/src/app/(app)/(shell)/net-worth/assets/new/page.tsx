import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { AssetFormPage } from '../../form-pages';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('asset.form'))('newTitle') };
}

export default async function NewAssetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <AssetFormPage query={await searchParams} />;
}
