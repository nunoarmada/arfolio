'use client';

import { AlertTriangle, CheckCircle2, PiggyBank, Receipt, Scale, TrendingUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { BudgetMonthView } from '@arfolio/services';
import type { MonthState } from '@/lib/budget-period';
import { lineStatus, summaryStatus, type BudgetKind } from '@/lib/budget-status';
import { KpiGrid } from '../home/kpi-tiles';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { DeltaChip, KpiTile, type DeltaTone } from '../ui/kpi-tile';
import { BudgetProgressBar } from './progress-bar';
import { SummaryHeadline } from './status-label';
import { useFormatMoney } from '@/components/privacy';

/**
 * The 10-second answer: four tiles (spending against the plan with today's pace, income, savings,
 * what is left to allocate) and one sentence that says how the month stands. Only booked
 * movements count; pending ones are named in the caption, never added in.
 */
export function MonthSummary({
  view,
  state,
  pace,
  unbudgeted = 0,
}: {
  view: BudgetMonthView;
  state: MonthState;
  pace: number | null;
  /** Booked spending that no line covers (not part of the plan figures above). */
  unbudgeted?: number;
}) {
  const t = useTranslations('budget.summary');
  const kpi = useTranslations('home.kpi');
  const status = useTranslations('budget.status');
  const kinds = useTranslations('budget.kinds');
  const allocation = useTranslations('budget.allocation');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const money = (minor: number) => formatMoney(minor, currency, locale);
  const { expense, income, saving } = view.totals;
  const headline = summaryStatus(view.lines, expense, state, pace);
  const pending = expense.pending + income.pending + saving.pending;
  const over = expense.actual - expense.planned;
  const future = state === 'future';

  /** The chip of an income or savings tile: the line status word, calm unless it is good news. */
  const kindChip = (kind: BudgetKind, cell: { planned: number; actual: number }) => {
    if (future || (cell.planned === 0 && cell.actual <= 0)) return undefined;
    const s = lineStatus(kind, cell.planned, cell.actual, state);
    const tone: DeltaTone = s.tone === 'positive' ? 'positive' : 'neutral';
    return (
      <DeltaChip tone={tone} icon={s.icon === 'check' ? CheckCircle2 : undefined}>
        {status(s.key, { amount: money(s.amount), extra: money(s.extra ?? 0) })}
      </DeltaChip>
    );
  };

  const unallocated = view.unallocated;

  return (
    <section aria-labelledby="month-summary" className="grid grid-cols-1 gap-3">
      <h2 id="month-summary" className="sr-only">
        {t('title')}
      </h2>
      <KpiGrid label={kpi('label')}>
        <KpiTile
          label={kinds('expensePlural')}
          icon={Receipt}
          value={
            <MoneyAmount minor={expense.actual} currency={currency} kind="neutral" size="kpi" />
          }
          delta={
            future ? undefined : over > 0 ? (
              <DeltaChip tone="negative" icon={AlertTriangle}>
                {status('over', { amount: money(over) })}
              </DeltaChip>
            ) : (
              <DeltaChip tone="neutral">{status('left', { amount: money(-over) })}</DeltaChip>
            )
          }
          comparison={
            future
              ? status('planned', { amount: money(expense.planned) })
              : t('ofPlanned', { planned: money(expense.planned) })
          }
          footer={
            <BudgetProgressBar
              kind="expense"
              planned={expense.planned}
              actual={expense.actual}
              state={state}
              pace={pace}
              paceCaption={state === 'current' && pace !== null ? t('today') : undefined}
              compact
              label={t('barLabel')}
            />
          }
        />
        <KpiTile
          label={kinds('incomePlural')}
          icon={TrendingUp}
          value={
            <MoneyAmount minor={income.actual} currency={currency} kind="neutral" size="kpi" />
          }
          delta={kindChip('income', income)}
          comparison={t('ofPlanned', { planned: money(income.planned) })}
        />
        <KpiTile
          label={kinds('savingPlural')}
          icon={PiggyBank}
          value={
            <MoneyAmount minor={saving.actual} currency={currency} kind="neutral" size="kpi" />
          }
          delta={kindChip('saving', saving)}
          comparison={t('ofPlanned', { planned: money(saving.planned) })}
        />
        <KpiTile
          label={allocation('title')}
          icon={Scale}
          value={
            <MoneyAmount minor={unallocated.actual} currency={currency} kind="balance" size="kpi" />
          }
          delta={
            unallocated.actual < 0 ? (
              <DeltaChip tone="negative" icon={AlertTriangle}>
                {allocation('short')}
              </DeltaChip>
            ) : undefined
          }
          comparison={`${allocation('planned')} ${money(unallocated.planned)}`}
        />
      </KpiGrid>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
        <SummaryHeadline status={headline} />
        <p className="min-w-0 text-sm text-muted-foreground">
          {t('caption')}
          {pending !== 0 ? ` ${t('captionPending', { amount: money(Math.abs(pending)) })}` : ''}
          {!future && unbudgeted > 0 ? ` ${t('unbudgeted', { amount: money(unbudgeted) })}.` : ''}
        </p>
      </div>
    </section>
  );
}
