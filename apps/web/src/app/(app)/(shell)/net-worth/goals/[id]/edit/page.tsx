import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { GoalFormPage } from '../../form-page';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('goals.form'))('editTitle') };
}

export default async function EditGoalPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return <GoalFormPage id={id} query={query} />;
}
