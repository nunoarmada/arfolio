import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { LineEditor, type LineKind } from '@/components/budget/line-editor';
import { PageHeader } from '@/components/page-header';
import { buttonVariants } from '@/components/ui/button';
import { REPORT_BACK } from '@/lib/reports';
import { safeNext } from '@/lib/safe-redirect';
import { loadLineEditor } from '@/server/budget-data';
import { getHouseholdSettings } from '@/server/household';
import { requireMember } from '@/server/session';
import { toServiceCtx } from '@/server/service-ctx';
import { PageContainer } from '@/components/page-container';

const KINDS: readonly LineKind[] = ['income', 'expense', 'saving'];

/** The line editor's page, for a new line or an existing one. Viewers get a 404. */
export async function LineEditorPage({
  lineId,
  query,
}: {
  lineId?: string;
  query: Record<string, string | string[] | undefined>;
}) {
  const h = await headers();
  const [session, t, settings] = await Promise.all([
    requireMember(h, { roles: ['owner', 'member'] }),
    getTranslations('budgetLine'),
    getHouseholdSettings(h),
  ]);
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const requestedBack = safeNext(one(query.back), '/budget');
  // A report page may send people here (an anomaly's "see the line"), so they can return to it.
  const back =
    requestedBack.startsWith('/budget') || REPORT_BACK.test(requestedBack)
      ? requestedBack
      : '/budget';
  const data = await loadLineEditor(
    toServiceCtx(session),
    lineId ? { lineId } : { budgetId: one(query.budget) ?? null },
  );
  if (data.kind === 'missing') {
    return (
      <PageContainer width="narrow">
        <PageHeader
          title={t(lineId ? 'missingTitle' : 'newTitle')}
          backHref={back}
          backLabel={t('back')}
        />
        <EmptyState
          className="max-w-[640px]"
          title={t('missing')}
          action={
            <Link href="/budget" className={buttonVariants({})}>
              {t('backToBudget')}
            </Link>
          }
        >
          {t('missingBody')}
        </EmptyState>
      </PageContainer>
    );
  }
  const kind = one(query.kind);
  const defaultKind = KINDS.find((k) => k === kind) ?? 'expense';
  return (
    <PageContainer width="narrow">
      <PageHeader
        title={data.line ? data.line.name : t('newTitle')}
        description={data.budget.name}
        backHref={back.split('#')[0]!}
        backLabel={t('back')}
      />
      <LineEditor
        key={data.line?.id ?? 'new'}
        budget={data.budget}
        line={data.line}
        defaultKind={defaultKind}
        others={data.others}
        bucketsByAccount={data.bucketsByAccount}
        lookups={data.lookups}
        hubAccountId={settings.hubAccountId}
        back={back}
      />
    </PageContainer>
  );
}
