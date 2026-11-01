'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { BudgetLineView } from '@arfolio/services';
import { lineTransactionsLink } from '@/lib/budget-links';
import { truncateName } from '@/lib/budget-import-copy';
import type { MonthState } from '@/lib/budget-period';
import { linePace, lineStatus } from '@/lib/budget-status';
import { cn } from '@/lib/cn';
import type { LineInfoDto } from '@/server/budget-data';
import type { CategoryDto } from '@/server/serialize';
import { CategoryChip } from '../category-icon';
import { useHouseholdFormat } from '../household-format';
import { buttonVariants } from '../ui/button';
import { Sheet } from '../ui/sheet';
import { BudgetProgressBar } from './progress-bar';
import { StatusLabel } from './status-label';
import { useFormatMoney } from '@/components/privacy';

/** What opens when a line of the month view is tapped: its numbers, categories and ways on. */
export function LineSheet({
  open,
  onOpenChange,
  line,
  info,
  state,
  pace,
  range,
  groupName,
  accountName,
  categories,
  editHref,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  line: BudgetLineView | null;
  info: LineInfoDto | null;
  state: MonthState;
  pace: number | null;
  range: { from: string; to: string };
  groupName: string | null;
  accountName: string | null;
  categories: ReadonlyMap<string, CategoryDto>;
  /** Present only for people who can edit. */
  editHref: string | null;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const t = useTranslations('budget.sheet');
  const kinds = useTranslations('budget.kinds');
  const common = useTranslations('common');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const money = (minor: number) => formatMoney(minor, currency, locale);

  if (!line || !info) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange} title={t('fallbackTitle')} tall>
        <span />
      </Sheet>
    );
  }

  const linePaceFraction = linePace(pace, line);
  const status = lineStatus(line.kind, line.planned, line.actual, state, linePaceFraction, {
    noData: line.noData,
  });
  const link = lineTransactionsLink(info, range);
  const linked = info.categoryIds
    .map((id) => categories.get(id))
    .filter((c): c is CategoryDto => c !== undefined);
  const remaining = line.planned - line.actual;
  const meta = [kinds(line.kind), groupName, accountName].filter(Boolean).join(' · ');

  const rows: Array<[string, string, string?]> = [
    [t('planned'), money(line.planned)],
    [t('actual'), status.key === 'noData' ? t('noData') : money(line.actual)],
    ...(line.pending !== 0
      ? [
          [t('pending'), money(Math.abs(line.pending)), t('notIncluded')] as [
            string,
            string,
            string,
          ],
        ]
      : []),
    remaining < 0 && line.kind === 'expense'
      ? [t('remaining'), t('over', { amount: money(-remaining) })]
      : [t('remaining'), money(Math.max(remaining, 0))],
  ];

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={truncateName(line.name, 60)}
      description={meta}
      tall
      onCloseAutoFocus={onCloseAutoFocus}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          {link ? (
            <Link href={link} className={buttonVariants({ variant: 'outline' })}>
              {t('viewTransactions')}
            </Link>
          ) : null}
          {editHref ? (
            <Link href={editHref} className={buttonVariants({})}>
              {t('edit')}
            </Link>
          ) : null}
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-5">
        <div className="grid grid-cols-1 gap-2">
          <StatusLabel status={status} />
          <BudgetProgressBar
            kind={line.kind}
            planned={line.planned}
            actual={line.actual}
            state={state}
            pace={linePaceFraction}
            label={line.name}
            noData={status.key === 'noData'}
          />
        </div>

        <dl className="divide-y divide-border rounded-md bg-surface-2 px-4">
          {rows.map(([label, value, note]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 py-3">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd
                className={cn(
                  'text-right text-base font-medium tabular-nums',
                  note ? 'text-muted-foreground' : '',
                )}
              >
                {value}
                {note ? (
                  <span className="block text-sm font-normal text-muted-foreground">{note}</span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>

        <section aria-labelledby="line-categories" className="grid grid-cols-1 gap-2">
          <h3 id="line-categories" className="text-sm font-medium text-muted-foreground">
            {t('categories')}
          </h3>
          {linked.length > 0 ? (
            <ul className="flex flex-wrap gap-2">
              {linked.map((c) => (
                <li key={c.id} className="max-w-full">
                  <CategoryChip category={c} uncategorisedLabel={common('uncategorised')} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-base">{t('noCategories')}</p>
          )}
          {line.kind === 'saving' && info.accountId ? (
            <p className="text-sm text-muted-foreground">
              {t(info.bucketIds.length > 0 ? 'savingCountsPies' : 'savingCounts', {
                account: accountName ?? t('removedAccount'),
              })}
            </p>
          ) : null}
        </section>

        {line.foreignCurrencyRows > 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('foreign', { count: line.foreignCurrencyRows })}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
