import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { AdvisorPage } from '@/components/advisor/advisor-page';
import { getBrand } from '@/lib/brand';
import { loadAdvisorState } from '@/server/advisor-data';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('advisor'))('title', { brand: getBrand().name }) };
}

/** The advisor as a page. When AI is off the same chat explains it (and where an owner turns it on). */
export default async function AdvisorRoute() {
  const ctx = toServiceCtx(await requireMember(await headers()));
  return <AdvisorPage initial={await loadAdvisorState(ctx)} />;
}
