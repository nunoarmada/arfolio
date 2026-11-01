import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { LiabilityFormPage } from '../../form-pages';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('liability.form'))('newTitle') };
}

export default async function NewLiabilityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <LiabilityFormPage query={await searchParams} />;
}
