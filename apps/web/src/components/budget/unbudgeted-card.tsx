'use client';

import { Clock, Link2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { UnbudgetedRow } from '@arfolio/services';
import { categoryTransactionsLink } from '@/lib/budget-links';
import { truncateName } from '@/lib/budget-import-copy';
import { linkCategoryToLineAction } from '@/server/actions/budget';
import type { LineInfoDto } from '@/server/budget-data';
import type { CategoryDto } from '@/server/serialize';
import { CategoryIcon } from '../category-icon';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Sheet } from '../ui/sheet';
import { useToast } from '../ui/toast';
import { useFailureMessage } from '../use-action-error';
import { useFormatMoney } from '@/components/privacy';

/**
 * "Fora do orçamento": spending in categories no line covers. Writers can link such a category
 * to an expense line without leaving the page.
 */
export function UnbudgetedCard({
  rows,
  categories,
  expenseLines,
  range,
  canWrite,
}: {
  rows: UnbudgetedRow[];
  categories: ReadonlyMap<string, CategoryDto>;
  expenseLines: LineInfoDto[];
  range: { from: string; to: string };
  canWrite: boolean;
}) {
  const t = useTranslations('budget.unbudgeted');
  const common = useTranslations('common');
  const toast = useToast();
  const router = useRouter();
  const failure = useFailureMessage();
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const money = (minor: number) => formatMoney(minor, currency, locale);
  const [target, setTarget] = useState<UnbudgetedRow | null>(null);
  const [lineId, setLineId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (rows.length === 0) return null;
  const total = rows.reduce((sum, r) => sum + r.actual, 0);

  function close() {
    setTarget(null);
    setLineId('');
    setError(null);
  }

  function link() {
    if (!target?.categoryId || !lineId) return;
    const categoryName = categories.get(target.categoryId)?.name ?? target.categoryName ?? '';
    const lineName = expenseLines.find((l) => l.id === lineId)?.name ?? '';
    setError(null);
    startTransition(async () => {
      const result = await linkCategoryToLineAction(lineId, target.categoryId!);
      if (!result.ok) return setError(failure(result));
      toast.success(
        t('linked', { category: truncateName(categoryName), line: truncateName(lineName) }),
      );
      close();
      router.refresh();
    });
  }

  return (
    <section aria-labelledby="unbudgeted-title" className="grid grid-cols-1 gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="unbudgeted-title" className="text-lg font-semibold">
          {t('title')}
        </h2>
        <MoneyAmount minor={total} currency={currency} kind="expense" />
      </div>
      <p className="text-sm text-muted-foreground">{t('help')}</p>
      <ul className="divide-y overflow-hidden rounded-lg bg-surface shadow-card">
        {rows.map((row) => {
          const category = row.categoryId ? categories.get(row.categoryId) : undefined;
          const name = category?.name ?? row.categoryName ?? common('uncategorised');
          return (
            <li key={row.categoryId ?? 'none'} className="flex items-center">
              <Link
                href={categoryTransactionsLink(row.categoryId, range)}
                className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-4 py-2 hover:bg-surface-2"
              >
                <CategoryIcon category={category} size={36} />
                <span className="grid grid-cols-1 min-w-0 flex-1">
                  <span className="line-clamp-2 break-words text-base" title={name}>
                    {truncateName(name, 60)}
                  </span>
                  {row.pending !== 0 ? (
                    <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                      <Clock className="size-3.5" aria-hidden="true" />
                      {t('pending', { amount: money(Math.abs(row.pending)) })}
                    </span>
                  ) : null}
                </span>
                <MoneyAmount minor={row.actual} currency={currency} kind="expense" />
              </Link>
              {canWrite && !row.categoryId ? (
                <Link
                  href="/transactions/review"
                  className="mr-1 inline-flex min-h-11 items-center rounded-md px-2 text-sm text-primary hover:underline"
                >
                  {t('review')}
                </Link>
              ) : null}
              {canWrite && row.categoryId && expenseLines.length > 0 ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="mr-1 text-muted-foreground"
                  aria-label={t('linkTo', { category: truncateName(name) })}
                  title={t('linkAction')}
                  onClick={() => setTarget(row)}
                >
                  <Link2 className="size-5" aria-hidden="true" />
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

      <Sheet
        open={target !== null}
        onOpenChange={(next) => (next ? undefined : close())}
        title={t('sheetTitle', {
          category: truncateName(
            (target?.categoryId ? categories.get(target.categoryId)?.name : null) ??
              target?.categoryName ??
              '',
          ),
        })}
        description={t('sheetHelp')}
        tall
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              {common('cancel')}
            </Button>
            <Button loading={pending} disabled={!lineId} onClick={link}>
              {t('linkConfirm')}
            </Button>
          </div>
        }
      >
        <div className="grid grid-cols-1 gap-3">
          {error ? <Alert tone="error">{error}</Alert> : null}
          <fieldset className="grid grid-cols-1 gap-1">
            <legend className="sr-only">{t('sheetLegend')}</legend>
            {expenseLines.map((line) => (
              <label
                key={line.id}
                className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 hover:bg-surface-2 has-[:checked]:border-primary has-[:checked]:bg-primary-soft has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring"
              >
                <input
                  type="radio"
                  name="unbudgeted-line"
                  value={line.id}
                  checked={lineId === line.id}
                  onChange={() => setLineId(line.id)}
                  className="size-5 shrink-0 accent-[var(--primary)]"
                />
                <span className="min-w-0 break-words text-base">{truncateName(line.name, 60)}</span>
              </label>
            ))}
          </fieldset>
        </div>
      </Sheet>
    </section>
  );
}
