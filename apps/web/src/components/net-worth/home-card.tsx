'use client';

import { useTranslations } from 'next-intl';
import type { HomeNetWorth } from '@/server/net-worth-data';
import { formatMonth } from '@/lib/dates';
import { shiftMonth } from '@/lib/net-worth-chart';
import { sparkline } from '@/lib/sparkline';
import { BlockError } from '../home/block-frame';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { Card, CardHeader } from '../ui/card';
import { ChangeLabel } from './change-label';
import { Sparkline } from './sparkline';
import { useFormatMoney } from '@/components/privacy';

const MINUS = '−';

/**
 * Net worth over the last 12 months as an area chart: the figure and its change on top, the brand
 * line over a gradient with dashed guides, and the first and last month at the foot. A failure
 * here never breaks the page.
 */
export function NetWorthHomeCard({
  data,
  currentMonth,
}: {
  data: HomeNetWorth;
  currentMonth: string;
}) {
  const t = useTranslations('home.netWorth');
  const { locale } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  if (data.kind === 'error') {
    return (
      <BlockError
        titleId="home-net-worth-title"
        title={t('title')}
        message={t('error')}
        retry={t('retry')}
        link={{ href: '/net-worth', label: t('see') }}
        className="min-h-[128px]"
      />
    );
  }
  const geometry = sparkline(data.rows, data.scale);
  const signed = (minor: number) =>
    `${minor < 0 ? MINUS : ''}${formatMoney(Math.abs(minor), data.currency, locale)}`;
  // "Últimos 12 meses" is only true with a full year of months behind the line.
  const full = geometry !== null && geometry.first.month === shiftMonth(currentMonth, -11);
  return (
    <Card as="section" aria-labelledby="home-net-worth-title" className="flex flex-col">
      <CardHeader
        title={t('title')}
        titleId="home-net-worth-title"
        description={t('label')}
        link={{ href: '/net-worth', label: t('see') }}
      />
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <div data-testid="home-net-worth">
          <MoneyAmount
            minor={data.net}
            currency={data.currency}
            kind="balance"
            size="kpi"
            dimCents
          />
        </div>
        <ChangeLabel change={data.change} currentMonth={currentMonth} compact />
      </div>
      {data.foreignCount > 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">
          {t('foreignNotice', { count: data.foreignCount })}
        </p>
      ) : null}
      {geometry ? (
        <div className="mt-4 flex flex-1 flex-col justify-end gap-2">
          <Sparkline
            testId="home-net-worth-sparkline"
            geometry={geometry}
            area
            grid
            className="h-32 md:h-40 xl:h-44"
            caption={t(full ? 'trend' : 'trendSince', {
              month: formatMonth(geometry.first.month, locale),
              first: signed(geometry.first.net),
              last: signed(geometry.last.net),
            })}
          />
          <p
            aria-hidden="true"
            className="flex items-center justify-between gap-3 text-caption tabular-nums text-muted-foreground"
          >
            <span className="whitespace-nowrap">{formatMonth(geometry.first.month, locale)}</span>
            <span className="whitespace-nowrap">{formatMonth(geometry.last.month, locale)}</span>
          </p>
        </div>
      ) : null}
    </Card>
  );
}
