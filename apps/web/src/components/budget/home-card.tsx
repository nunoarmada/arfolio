'use client';

import { CalendarClock, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { BudgetMonthView } from '@arfolio/services';
import { monthParam } from '@/lib/budget-period';
import { linePace, lineStatus, summaryStatus } from '@/lib/budget-status';
import { formatMonth } from '@/lib/dates';
import { formatShare, paceSummary } from '@/lib/home-pace';
import { cn } from '@/lib/cn';
import { BlockError } from '../home/block-frame';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { buttonVariants } from '../ui/button';
import { Card, CardHeader, IconTile } from '../ui/card';
import { BudgetProgressBar } from './progress-bar';
import { StatusLabel, SummaryHeadline } from './status-label';
import { useFormatMoney } from '@/components/privacy';

/** Expense lines over their plan or at 85% and more, worst first (at most three). */
export function linesNeedingAttention(view: BudgetMonthView) {
  return view.lines
    .filter(
      (l) =>
        l.kind === 'expense' &&
        ((l.planned === 0 && l.actual > 0) || (l.planned > 0 && l.actual * 100 >= 85 * l.planned)),
    )
    .sort(
      (a, b) =>
        (b.planned > 0 ? b.actual / b.planned : Infinity) -
        (a.planned > 0 ? a.actual / a.planned : Infinity),
    )
    .slice(0, 3);
}

/**
 * The month's budget card: the status sentence, what is left (the biggest figure on the page), the
 * bar with today's pace and what it means, then the lines that need a look, each with its own
 * small bar. Red only shows when the plan is genuinely exceeded, and then only in the headline,
 * the bar and the icon: the hero stays neutral ink (what was spent of the plan), so the alarm is
 * said once.
 */
export function HomeBudgetCard({
  view,
  month,
  pace,
  today,
  unbudgeted = 0,
}: {
  view: BudgetMonthView;
  month: string;
  pace: number | null;
  today: string;
  /** Booked spending that no line covers, shown as a hint beside the plan figure. */
  unbudgeted?: number;
}) {
  const t = useTranslations('home.budget');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const money = (minor: number) => formatMoney(minor, currency, locale);
  const { expense } = view.totals;
  const over = expense.actual > expense.planned;
  const status = summaryStatus(view.lines, expense, 'current', pace);
  const attention = linesNeedingAttention(view);
  const monthName = formatMonth(month, locale);
  const summary = paceSummary(today, month, expense.planned, expense.actual);

  return (
    <Card as="section" aria-labelledby="home-budget-title" className="flex flex-col">
      <CardHeader
        title={t('title', { month: monthName })}
        titleId="home-budget-title"
        link={{ href: `/budget?month=${monthParam(month)}`, label: t('see') }}
      />
      <div className="grid flex-1 grid-cols-1 grid-rows-[auto_1fr] gap-4">
        <div
          data-testid="home-budget-hero"
          className="grid grid-cols-1 min-w-0 content-start gap-3"
        >
          <SummaryHeadline status={status} />
          <p className="flex flex-wrap items-baseline gap-x-2 text-base text-muted-foreground">
            {t.rich(over ? 'spentOf' : 'left', {
              amount: () => (
                <MoneyAmount
                  minor={over ? expense.actual : expense.planned - expense.actual}
                  currency={currency}
                  kind="neutral"
                  size="hero"
                  dimCents
                />
              ),
              of: (chunks) => <span className="whitespace-nowrap">{chunks}</span>,
              planned: money(expense.planned),
            })}
          </p>
          <div className="mt-1">
            <BudgetProgressBar
              kind="expense"
              planned={expense.planned}
              actual={expense.actual}
              state="current"
              pace={pace}
              label={t('barLabel')}
            />
          </div>
          {summary ? (
            <p className="text-sm text-muted-foreground">
              {t('paceLegend', { day: summary.day, days: summary.days })}
              {' · '}
              {t('paceSentence', {
                spent: formatShare(summary.spent, locale),
                elapsed: formatShare(summary.elapsed, locale),
              })}
            </p>
          ) : null}
          <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))]">
            {[
              {
                key: 'inc',
                label: t('statIncome'),
                minor: view.totals.income.actual,
                of: view.totals.income.planned,
              },
              {
                key: 'sav',
                label: t('statSaving'),
                minor: view.totals.saving.actual,
                of: view.totals.saving.planned,
              },
              ...(unbudgeted > 0
                ? [
                    {
                      key: 'unb',
                      label: t('statUnbudgeted'),
                      minor: unbudgeted,
                      note: null as string | null,
                    },
                  ]
                : []),
              ...(expense.pending !== 0
                ? [
                    {
                      key: 'pen',
                      label: t('statPending'),
                      minor: Math.abs(expense.pending),
                      note: t('statPendingNote'),
                    },
                  ]
                : []),
            ].map((x) => (
              <div key={x.key} className="min-w-0 rounded-md bg-surface-2 px-3 py-2.5">
                <dt className="text-label text-muted-foreground">{x.label}</dt>
                <dd className="mt-0.5 text-base font-semibold tabular-nums">{money(x.minor)}</dd>
                <dd className="text-caption font-normal text-muted-foreground">
                  {'of' in x && x.of !== undefined && x.of > 0
                    ? t('statOf', { planned: money(x.of) })
                    : 'note' in x && x.note
                      ? x.note
                      : '\u00a0'}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        {attention.length > 0 ? (
          <div className="-mx-4 self-end border-t pt-0 md:-mx-5 xl:-mx-6">
            <h3 className="px-4 pb-1 pt-3 text-label text-muted-foreground md:px-5 xl:px-6">
              {t('attention')}
            </h3>
            <ul data-testid="home-attention-lines" className="divide-y">
              {attention.map((line) => (
                <li key={line.lineId}>
                  <Link
                    href={`/budget?month=${monthParam(month)}#line-${line.lineId}`}
                    className="group grid grid-cols-1 gap-2 px-4 py-3 transition-colors duration-[120ms] hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 md:px-5 xl:px-6"
                  >
                    <span className="flex items-center justify-between gap-3">
                      <span
                        className="line-clamp-2 min-w-0 break-words text-base font-medium"
                        title={line.name}
                      >
                        {line.name}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        <StatusLabel
                          status={lineStatus(
                            'expense',
                            line.planned,
                            line.actual,
                            'current',
                            linePace(pace, line),
                          )}
                          className="text-right"
                        />
                        <ChevronRight
                          className="size-4 text-subtle-foreground transition-transform duration-[120ms] group-hover:translate-x-0.5 motion-reduce:transition-none"
                          aria-hidden="true"
                        />
                      </span>
                    </span>
                    <span aria-hidden="true">
                      <BudgetProgressBar
                        kind="expense"
                        planned={line.planned}
                        actual={line.actual}
                        state="current"
                        compact
                        label={line.name}
                      />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * With no budget for the month the card still answers "how is this month going": what has been
 * spent, plus the way to make a budget (for those who can).
 */
export function HomeNoBudgetCard({
  spent,
  canWrite,
}: {
  /** Household-currency spending this month. */
  spent: { expense: number; currency: string };
  canWrite: boolean;
}) {
  const t = useTranslations('home');
  return (
    <Card as="section" aria-labelledby="home-month-title" className="flex flex-col">
      <CardHeader title={t('noBudget.title')} titleId="home-month-title" />
      <div data-testid="home-budget-hero" className="grid grid-cols-1 min-w-0 gap-4">
        <p className="flex items-center gap-3 text-sm text-muted-foreground">
          <IconTile icon={CalendarClock} />
          <span>{t('budget.none')}</span>
        </p>
        <div className="grid grid-cols-1 gap-1">
          <p className="text-label text-muted-foreground">{t('noBudget.spent')}</p>
          <MoneyAmount
            minor={spent.expense}
            currency={spent.currency}
            kind="neutral"
            size="hero"
            dimCents
          />
          <p className="text-sm text-muted-foreground">{t('excludingTransfers')}</p>
        </div>
        {canWrite ? (
          <Link href="/budget/new" className={cn(buttonVariants({}), 'w-full sm:w-fit')}>
            {t('budget.create')}
          </Link>
        ) : (
          <p className="text-sm text-muted-foreground">{t('noBudget.viewerHint')}</p>
        )}
      </div>
    </Card>
  );
}

/** The budget failed to load: its frame, with the page standing. */
export function HomeBudgetError() {
  const t = useTranslations('home');
  return (
    <BlockError
      titleId="home-month-title"
      title={t('noBudget.title')}
      message={t('budget.error')}
      retry={t('budget.retry')}
      className="min-h-[208px]"
    />
  );
}
