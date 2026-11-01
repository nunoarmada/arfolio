'use client';

import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Landmark,
  Minus,
  PiggyBank,
  Receipt,
  TrendingUp,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { BudgetMonthView } from '@arfolio/services';
import type { HomeNetWorth } from '@/server/net-worth-data';
import { formatMonth } from '@/lib/dates';
import { shiftMonth } from '@/lib/net-worth-chart';
import { formatMonthRelative } from '@/lib/net-worth-format';
import { sparkline } from '@/lib/sparkline';
import { BudgetProgressBar } from '../budget/progress-bar';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { Sparkline } from '../net-worth/sparkline';
import { DeltaChip, KpiTile } from '../ui/kpi-tile';
import { useFormatMoney } from '@/components/privacy';

const MINUS = '−';

/** The strip: two by two on phones and tablets, four across from lg. */
export function KpiGrid({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 md:gap-4 lg:grid-cols-4"
    >
      {children}
    </div>
  );
}

/** Disponível: the one hero tile of the page, with the dimmed cents. */
export function AvailableKpi({
  available,
  count,
  currency,
  otherCurrency,
  segments,
}: {
  available: number;
  count: number;
  currency: string;
  otherCurrency: number;
  /** Positive balances behind the figure, largest first: where the money sits. */
  segments: { name: string; value: number }[];
}) {
  const t = useTranslations('home.kpi');
  const { locale } = useHouseholdFormat();
  const total = segments.reduce((a, s) => a + s.value, 0);
  const OPACITY = [1, 0.7, 0.5, 0.35, 0.22];
  return (
    <KpiTile
      hero
      href="/accounts"
      label={t('available')}
      icon={Landmark}
      value={
        <MoneyAmount minor={available} currency={currency} kind="balance" size="kpi" dimCents />
      }
      footer={
        total > 0 ? (
          <div>
            <div aria-hidden="true" className="flex h-2 gap-0.5 overflow-hidden rounded-full">
              {segments.map((s, i) => (
                <span
                  key={s.name + i}
                  className="h-full bg-primary"
                  style={{ flexGrow: s.value, opacity: OPACITY[Math.min(i, OPACITY.length - 1)] }}
                />
              ))}
            </div>
            <p className="sr-only">
              {segments
                .map(
                  (s) =>
                    `${s.name}: ${new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(s.value / total)}`,
                )
                .join('; ')}
            </p>
          </div>
        ) : null
      }
      comparison={
        <>
          <span className="whitespace-nowrap">{t('availableIn', { count })}</span>
          {otherCurrency > 0 ? (
            <>
              {' '}
              <span className="whitespace-nowrap">
                {t('availableForeign', { count: otherCurrency })}
              </span>
            </>
          ) : null}
        </>
      }
    />
  );
}

/**
 * Gasto este mês: spending against the plan, with the bar and the pace tick. Calm until it is
 * actually over: "Restam" is a neutral chip, only "Acima" is red.
 */
export function SpendKpi({
  view,
  pace,
  spent,
}: {
  /** The month's budget view; without one, `spent` is what the tile shows. */
  view: BudgetMonthView | null;
  pace: number | null;
  spent: number;
}) {
  const t = useTranslations('home.kpi');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const money = (minor: number) => formatMoney(minor, currency, locale);
  if (!view) {
    return (
      <KpiTile
        href="/budget"
        label={t('spent')}
        icon={Receipt}
        value={<MoneyAmount minor={spent} currency={currency} kind="neutral" size="kpi" />}
        comparison={t('spentNoBudget')}
      />
    );
  }
  const { expense } = view.totals;
  const over = expense.actual - expense.planned;
  return (
    <KpiTile
      href="/budget"
      label={t('spent')}
      icon={Receipt}
      value={<MoneyAmount minor={expense.actual} currency={currency} kind="neutral" size="kpi" />}
      delta={
        over > 0 ? (
          <DeltaChip tone="negative" icon={AlertTriangle}>
            {t('over', { amount: money(over) })}
          </DeltaChip>
        ) : (
          <DeltaChip tone="neutral">{t('left', { amount: money(-over) })}</DeltaChip>
        )
      }
      comparison={t('spentOf', { planned: money(expense.planned) })}
      footer={
        <BudgetProgressBar
          kind="expense"
          planned={expense.planned}
          actual={expense.actual}
          state="current"
          pace={pace}
          compact
          label={t('barLabel')}
        />
      }
    />
  );
}

/**
 * Poupança do mês from the budget's savings lines; without a budget, "Fluxo do mês" (income minus
 * spending) says how the month is going instead.
 */
export function SavingsKpi({
  view,
  income,
  expense,
}: {
  view: BudgetMonthView | null;
  /** Without a budget: this month's income and spending. */
  income: number;
  expense: number;
}) {
  const t = useTranslations('home.kpi');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const money = (minor: number) => formatMoney(minor, currency, locale);
  if (!view) {
    const flow = income - expense;
    return (
      <KpiTile
        href="/transactions"
        label={t('flow')}
        icon={TrendingUp}
        value={<MoneyAmount minor={flow} currency={currency} kind="neutral" size="kpi" />}
        comparison={
          <>
            <span className="whitespace-nowrap">{t('flowIncome', { amount: money(income) })}</span>
            {' · '}
            <span className="whitespace-nowrap">
              {t('flowExpense', { amount: money(expense) })}
            </span>
          </>
        }
      />
    );
  }
  const { saving } = view.totals;
  const done = saving.planned > 0 && saving.actual >= saving.planned;
  return (
    <KpiTile
      href="/budget"
      label={t('savings')}
      icon={PiggyBank}
      value={<MoneyAmount minor={saving.actual} currency={currency} kind="neutral" size="kpi" />}
      delta={
        done ? (
          <DeltaChip tone="positive" icon={CheckCircle2}>
            {t('savingsDone')}
          </DeltaChip>
        ) : saving.planned > 0 ? (
          <DeltaChip tone="neutral">
            {t('savingsPercent', {
              percent: Math.max(0, Math.round((saving.actual * 100) / saving.planned)),
            })}
          </DeltaChip>
        ) : null
      }
      comparison={
        saving.planned > 0 ? t('savingsOf', { planned: money(saving.planned) }) : t('savingsNone')
      }
      footer={
        saving.planned > 0 ? (
          <BudgetProgressBar
            kind="saving"
            planned={saving.planned}
            actual={saving.actual}
            state="current"
            compact
            label={t('savingsBar')}
          />
        ) : null
      }
    />
  );
}

/** Património líquido: the figure, the change since last month and a 12-month sparkline. */
export function NetWorthKpi({
  data,
  currentMonth,
}: {
  data: Extract<HomeNetWorth, { kind: 'ready' }>;
  currentMonth: string;
}) {
  const t = useTranslations('home.kpi');
  const change = useTranslations('netWorth.change');
  const trend = useTranslations('home.netWorth');
  const { locale } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const geometry = sparkline(data.rows, data.scale);
  const signed = (minor: number) =>
    `${minor < 0 ? MINUS : ''}${formatMoney(Math.abs(minor), data.currency, locale)}`;
  const full = geometry !== null && geometry.first.month === shiftMonth(currentMonth, -11);
  const c = data.change;
  let delta: React.ReactNode = null;
  let comparison: React.ReactNode = null;
  if (c.kind === 'up' || c.kind === 'down') {
    const previous = c.kind === 'up' ? data.net - c.amount : data.net + c.amount;
    const pct =
      previous !== 0
        ? new Intl.NumberFormat(locale, {
            style: 'percent',
            maximumFractionDigits: 1,
            signDisplay: 'never',
          }).format(c.amount / Math.abs(previous))
        : null;
    delta = (
      <DeltaChip
        tone={c.kind === 'up' ? 'positive' : 'neutral'}
        icon={c.kind === 'up' ? ArrowUpRight : ArrowDownRight}
        sr={change(c.kind === 'up' ? 'upWord' : 'downWord')}
      >
        {c.kind === 'up' ? '+' : MINUS}
        {formatMoney(c.amount, data.currency, locale, { compact: true })}
        {pct ? ` · ${pct}` : ''}
      </DeltaChip>
    );
    comparison = change('vs', { month: formatMonthRelative(c.prevMonth, currentMonth, locale) });
  } else if (c.kind === 'flat') {
    delta = (
      <DeltaChip tone="neutral" icon={Minus}>
        {formatMoney(0, data.currency, locale, { compact: true })}
      </DeltaChip>
    );
    comparison = change('vs', { month: formatMonthRelative(c.prevMonth, currentMonth, locale) });
  } else if (c.kind === 'first') {
    comparison = change('first');
  }
  return (
    <KpiTile
      href="/net-worth"
      label={t('netWorth')}
      icon={TrendingUp}
      value={<MoneyAmount minor={data.net} currency={data.currency} kind="balance" size="kpi" />}
      delta={delta}
      comparison={comparison}
      footer={
        geometry ? (
          <Sparkline
            geometry={geometry}
            area
            className="h-9 md:h-9"
            caption={trend(full ? 'trend' : 'trendSince', {
              month: formatMonth(geometry.first.month, locale),
              first: signed(geometry.first.net),
              last: signed(geometry.last.net),
            })}
          />
        ) : null
      }
    />
  );
}
