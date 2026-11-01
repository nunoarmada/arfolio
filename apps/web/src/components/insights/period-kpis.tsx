'use client';

import {
  ArrowDownRight,
  ArrowLeftRight,
  ArrowUpRight,
  Minus,
  PiggyBank,
  ReceiptText,
  Wallet,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { monthKpis } from '@/lib/insights-kpis';
import type { TrendRow } from '@/lib/insights-chart';
import { signedMoney } from '@/lib/insights-format';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { DeltaChip, KpiTile, type DeltaTone } from '../ui/kpi-tile';
import { useFormatMoney } from '@/components/privacy';

/**
 * The KPI strip of Análises: spending and income of the selected period, the share of income that
 * went to saving, and how spending moved against the period before. All of it comes from the
 * twelve-month rows the trends section already loads.
 */
export function PeriodKpis({
  rows,
  months,
  currentMonth,
}: {
  rows: TrendRow[];
  months: readonly string[];
  currentMonth: string;
}) {
  const t = useTranslations('insights.kpi');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const k = monthKpis(rows, months);
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  const inProgress = months.includes(currentMonth);
  const change = k.previous;
  const sign = change ? Math.sign(change.deltaMinor) : 0;
  // Spending that fell is the favourable move; one that rose is just information, never red.
  const tone: DeltaTone = sign < 0 ? 'positive' : 'neutral';
  const Arrow = sign > 0 ? ArrowUpRight : sign < 0 ? ArrowDownRight : Minus;

  return (
    <div
      role="group"
      aria-label={t('label')}
      data-testid="insights-kpis"
      className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 md:gap-4 lg:grid-cols-4"
    >
      <KpiTile
        hero
        label={t('spending')}
        icon={Wallet}
        value={
          <MoneyAmount minor={k.expense} currency={currency} kind="neutral" size="kpi" dimCents />
        }
        comparison={inProgress ? t('inProgress') : undefined}
      />
      <KpiTile
        label={t('income')}
        icon={ReceiptText}
        value={<MoneyAmount minor={k.income} currency={currency} kind="balance" size="kpi" />}
      />
      <KpiTile
        label={t('savingRate')}
        icon={PiggyBank}
        value={
          <span className="money-hero text-kpi tabular-nums">
            {k.savingRateBps === null ? '—' : percent.format(k.savingRateBps / 10_000)}
          </span>
        }
        comparison={k.savingRateBps === null ? t('noIncome') : t('savingRateNote')}
      />
      <KpiTile
        label={t('change')}
        icon={ArrowLeftRight}
        value={
          <span className="money-hero text-kpi tabular-nums">
            {change
              ? signedMoney(formatMoney, change.deltaMinor, currency, locale, { plus: true })
              : '—'}
          </span>
        }
        delta={
          change && change.deltaBps !== null ? (
            <DeltaChip
              tone={tone}
              icon={Arrow}
              sr={sign > 0 ? t('up') : sign < 0 ? t('down') : t('flat')}
            >
              {percent.format(Math.abs(change.deltaBps) / 10_000)}
            </DeltaChip>
          ) : undefined
        }
        comparison={
          change
            ? inProgress
              ? t('inProgress')
              : t('was', { amount: formatMoney(change.expense, currency, locale) })
            : t('noPrevious')
        }
      />
    </div>
  );
}
