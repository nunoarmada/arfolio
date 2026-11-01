import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { listMembers, listPendingInvitations } from '@/server/members';
import { requireMember } from '@/server/session';
import { MembersView } from './members-view';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('members'))('title') };
}

export default async function MembersPage() {
  const h = await headers();
  const [ctx, t, settings] = await Promise.all([
    requireMember(h),
    getTranslations('members'),
    getTranslations('settings'),
  ]);
  const [members, pending] = await Promise.all([
    listMembers(h),
    ctx.role === 'owner' ? listPendingInvitations(h) : Promise.resolve([]),
  ]);
  return (
    <>
      <PageHeader title={t('title')} backHref="/settings" backLabel={settings('back')} />
      <MembersView members={members} pending={pending} isOwner={ctx.role === 'owner'} />
    </>
  );
}
