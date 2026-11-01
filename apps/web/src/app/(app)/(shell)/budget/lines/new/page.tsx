import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { LineEditorPage } from '../editor-page';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('budgetLine'))('newTitle') };
}

export default async function NewLinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <LineEditorPage query={await searchParams} />;
}
