import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { LiabilityFormPage } from '../../../form-pages';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('liability.form'))('editTitle') };
}

export default async function EditLiabilityPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return <LiabilityFormPage id={id} query={query} />;
}
