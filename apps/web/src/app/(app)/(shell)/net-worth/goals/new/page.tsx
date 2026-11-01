import { getTranslations } from 'next-intl/server';
import type { Metadata } from 'next';
import { GoalFormPage } from '../form-page';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('goals.form'))('newTitle') };
}

export default async function NewGoalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <GoalFormPage query={await searchParams} />;
}
