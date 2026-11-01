'use client';

import { Landmark } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';
import { signedMoney } from '@/lib/insights-format';
import type { ChartRow } from '@/lib/net-worth-chart';
import { formatDayYear, formatMonthYear } from '@/lib/net-worth-format';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { Card, IconTile } from '../ui/card';
import { ChangeLabel, type Change } from './change-label';
import { useFormatMoney } from '@/components/privacy';

/** The share of `part` in `whole` as a locale percentage, or null when there is nothing to share. */
export function shareText(part: number, whole: number, locale: string): string | null {
  if (whole <= 0) return null;
  const ratio = Math.min(Math.max(part / whole, 0), 1);
  const format = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  // A share that rounds to nothing is still something: "<1%", not "0%".
  return ratio > 0 && ratio < 0.005 ? `<${format.format(0.01)}` : format.format(ratio);
}

/**
 * The 10-second answer, as the page's hero card: what the household is worth (cents dimmed), how
 * that moved, and what it is made of as a two-tone bar of assets against liabilities. The bar is
 * an image with a sentence; the two rows under it carry the exact figures.
 */
export function NetWorthHeadline({
  net,
  assets,
  liabilities,
  change,
  today,
  currentMonth,
  rows = null,
}: {
  net: number;
  assets: number;
  liabilities: number;
  change: Change;
  today: string;
  currentMonth: string;
  /** The history the chart beside it already loaded, oldest first; null when it failed. */
  rows?: readonly ChartRow[] | null;
}) {
  const t = useTranslations('netWorth');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const gross = assets + liabilities;
  const assetShare = gross > 0 ? assets / gross : 0;
  const assetPct = shareText(assets, gross, locale);
  const liabilityPct = shareText(liabilities, gross, locale);
  const barText = `${t('assets')}: ${formatMoney(assets, currency, locale)}${
    assetPct ? ` (${assetPct})` : ''
  }. ${t('liabilities')}: ${formatMoney(liabilities, currency, locale)}${
    liabilityPct ? ` (${liabilityPct})` : ''
  }.`;
  return (
    <Card
      as="section"
      variant="hero"
      aria-labelledby="nw-headline-label"
      className="flex flex-col gap-4"
    >
      <div className="flex items-center gap-2">
        <IconTile icon={Landmark} />
        <p id="nw-headline-label" className="text-label text-muted-foreground">
          {t('netLabel')}
        </p>
      </div>
      <div data-testid="net-worth-total">
        <MoneyAmount
          minor={net}
          currency={currency}
          kind="balance"
          size="kpi"
          dimCents
          className="text-title max-sm:text-title max-[389px]:text-title sm:text-display lg:text-kpi min-[1400px]:text-kpi"
        />
      </div>
      <p data-testid="net-worth-change" className="min-h-6">
        <ChangeLabel change={change} currentMonth={currentMonth} compact />
      </p>

      <HistoryStats rows={rows} net={net} />

      <div className="grid grid-cols-1 gap-4">
        {gross > 0 ? (
          <div
            role="img"
            aria-label={barText}
            className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full"
          >
            <div className="rounded-full bg-primary" style={{ width: `${assetShare * 100}%` }} />
            <div className="min-w-0 flex-1 rounded-full bg-subtle-foreground" />
          </div>
        ) : null}
        <dl className="grid grid-cols-1 gap-2.5">
          <Row
            dot="bg-primary"
            label={t('assets')}
            share={assetPct}
            testId="net-worth-assets"
            amount={<MoneyAmount minor={assets} currency={currency} kind="balance" />}
          />
          <Row
            dot="bg-subtle-foreground"
            label={t('liabilities')}
            share={liabilityPct}
            testId="net-worth-liabilities"
            amount={<MoneyAmount minor={liabilities} currency={currency} kind="neutral" />}
          />
        </dl>
      </div>
      <p className="max-w-[68ch] text-label font-normal text-muted-foreground">
        {t('asOf', { date: formatDayYear(today, locale) })}
      </p>
    </Card>
  );
}

function Row({
  dot,
  label,
  share,
  amount,
  testId,
}: {
  dot: string;
  label: string;
  share: string | null;
  amount: React.ReactNode;
  testId: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <span aria-hidden="true" className={cn('size-2 shrink-0 self-center rounded-full', dot)} />
        {label}
        {share ? <span className="tabular-nums text-muted-foreground">{share}</span> : null}
      </dt>
      <dd data-testid={testId} className="shrink-0">
        {amount}
      </dd>
    </div>
  );
}

/**
 * Two small facts from the loaded history: how net worth moved since its first month and its
 * highest month. They follow the chart's period, and say from when, so they never claim more.
 */
function HistoryStats({ rows, net }: { rows: readonly ChartRow[] | null; net: number }) {
  const t = useTranslations('netWorth.stats');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  if (!rows || rows.length < 2) return null;
  const first = rows[0]!;
  const high = rows.reduce((best, r) => (r.net > best.net ? r : best), rows[0]!);
  const delta = net - first.net;
  const peak = Math.max(high.net, net);
  return (
    <dl
      data-testid="net-worth-stats"
      className="grid grid-cols-2 gap-3 rounded-md bg-surface-2 p-3"
    >
      <div className="min-w-0">
        <dt className="text-label text-muted-foreground">{t('change')}</dt>
        <dd className="mt-0.5 text-base font-semibold tabular-nums">
          {signedMoney(formatMoney, delta, currency, locale, { plus: true })}
        </dd>
        <dd className="text-label font-normal text-muted-foreground">
          {t('since', { month: formatMonthYear(first.month, locale) })}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-label text-muted-foreground">{t('high')}</dt>
        <dd className="mt-0.5 text-base font-semibold tabular-nums">
          {formatMoney(peak, currency, locale)}
        </dd>
        <dd className="text-label font-normal text-muted-foreground">
          {net >= high.net ? t('now') : t('at', { month: formatMonthYear(high.month, locale) })}
        </dd>
      </div>
    </dl>
  );
}
