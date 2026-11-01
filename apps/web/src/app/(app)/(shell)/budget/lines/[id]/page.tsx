import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { LineEditorPage } from '../editor-page';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('budgetLine'))('editTitle') };
}

export default async function EditLinePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return <LineEditorPage lineId={id} query={query} />;
}
