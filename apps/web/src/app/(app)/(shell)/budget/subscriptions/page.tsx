import { getBudget, listRecurring, recurringMonthlyCost } from '@arfolio/services';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { BudgetNav } from '@/components/budget/budget-nav';
import { SubscriptionsView } from '@/components/budget/subscriptions-view';
import { monthParam } from '@/lib/budget-period';
import { resolveBudget, toRecurringDto } from '@/server/budget-data';
import { loadLookups } from '@/server/lookups';
import { requireMember } from '@/server/session';
import { toServiceCtx } from '@/server/service-ctx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('recurring'))('title') };
}

export default async function SubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [session, query, budgetT] = await Promise.all([
    requireMember(await headers()),
    searchParams,
    getTranslations('budget'),
  ]);
  const ctx = toServiceCtx(session);
  const [items, cost, lookups, resolved] = await Promise.all([
    listRecurring(ctx),
    recurringMonthlyCost(ctx),
    loadLookups(ctx),
    resolveBudget(ctx, {}),
  ]);
  const lines =
    resolved.kind === 'ready'
      ? (await getBudget(ctx, resolved.budget.id)).lines.map((l) => ({ id: l.id, name: l.name }))
      : [];
  const edit = Array.isArray(query.edit) ? query.edit[0] : query.edit;
  return (
    <SubscriptionsView
      title={budgetT('title')}
      nav={
        <BudgetNav
          {...(resolved.kind === 'ready'
            ? { month: monthParam(resolved.month), start: monthParam(resolved.budget.startMonth) }
            : {})}
        />
      }
      items={items.map(toRecurringDto)}
      monthlyCost={cost}
      accounts={lookups.accounts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        archived: a.archived,
      }))}
      groups={lookups.groups}
      lines={lines}
      today={resolved.kind === 'ready' ? resolved.today : new Date().toISOString().slice(0, 10)}
      canWrite={session.role !== 'viewer'}
      initialEditId={edit ?? null}
    />
  );
}
