import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { ArchiveGoal } from '@/components/net-worth/archive-goal';
import { GoalForm } from '@/components/net-worth/goal-form';
import { PageHeader } from '@/components/page-header';
import { loadGoalForm } from '@/server/goals-data';
import { getHouseholdSettings } from '@/server/household';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';
import { PageContainer } from '@/components/page-container';

type Query = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The goal form's page, for a new goal or an existing one. Viewers get a 404. */
export async function GoalFormPage({ id, query }: { id?: string; query: Query }) {
  const h = await headers();
  const [session, t, common, settings] = await Promise.all([
    requireMember(h, { roles: ['owner', 'member'] }),
    getTranslations('goals.form'),
    getTranslations('common'),
    getHouseholdSettings(h),
  ]);
  const data = await loadGoalForm(toServiceCtx(session), id ?? null, settings.emergencyFundMonths);
  const back = '/net-worth/goals';
  return (
    <PageContainer width="narrow">
      <PageHeader
        title={id ? t('editTitle') : t('newTitle')}
        description={data.goal?.name}
        backHref={back}
        backLabel={common('back')}
      />
      <GoalForm
        key={id ?? 'new'}
        data={data}
        defaultKind={one(query.kind) ?? 'generic'}
        isOwner={session.role === 'owner'}
        back={back}
      />
      {data.goal ? (
        <div className="mt-6 grid grid-cols-1 max-w-[640px]">
          <ArchiveGoal id={data.goal.id} name={data.goal.name} />
        </div>
      ) : null}
    </PageContainer>
  );
}
