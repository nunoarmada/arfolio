import {
  listAccounts,
  listAssets,
  listBudgets,
  listCategories,
  listLiabilities,
} from '@arfolio/services';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { BudgetImportWizard } from '@/components/budget/import/budget-import-wizard';
import { linkableFor } from '@/lib/net-worth-links';
import { getHouseholdSettings } from '@/server/household';
import { requireMember } from '@/server/session';
import { toServiceCtx } from '@/server/service-ctx';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('budgetImport'))('title') };
}

export default async function ImportBudgetPage() {
  const h = await headers();
  const session = await requireMember(h, { roles: ['owner', 'member'] });
  const ctx = toServiceCtx(session);
  const [accounts, groups, budgets, settings, assets, liabilities] = await Promise.all([
    listAccounts(ctx, { includeArchived: true }),
    listCategories(ctx, { includeArchived: true }),
    listBudgets(ctx),
    getHouseholdSettings(h),
    listAssets(ctx),
    listLiabilities(ctx),
  ]);
  const linkable = accounts.map((a) => ({ ...a, archived: a.archivedAt !== null }));
  const claimedBy: Record<string, string> = {};
  for (const r of [...assets, ...liabilities]) {
    if (r.accountId) claimedBy[r.accountId] ??= r.id;
  }
  return (
    <BudgetImportWizard
      accountNames={accounts.map((a): [string, string] => [a.id, a.name])}
      linkableAccounts={{
        asset: linkableFor('asset', linkable, { current: null }),
        liability: linkableFor('liability', linkable, { current: null }),
        claimedBy,
      }}
      groupNames={groups.map((g): [string, string] => [g.id, g.name])}
      budgetNames={budgets.map((b): [string, string] => [b.id, b.name])}
      hubConfigured={settings.hubAccountId !== null}
    />
  );
}
