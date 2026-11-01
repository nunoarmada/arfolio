import { ChevronRight } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatDate } from '@/lib/dates';
import { anomalyLink, type AnomalyDto, type Role } from '@/lib/reports';
import { getFormatMoney } from '@/server/format-money';
import type { AnomaliesData } from '@/server/reports-data';
import { Card, CardHeader } from '../ui/card';
import { Skeleton } from '../ui/skeleton';

const CADENCES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;

/** The computed figures of the month, from the ledger: never model text. */
export async function AnomaliesSection({
  data,
  month,
  monthLabel,
  currency,
  locale,
  role,
  storedAt,
}: {
  data: AnomaliesData;
  month: string;
  monthLabel: string;
  currency: string;
  locale: string;
  role: Role;
  /** When the stored figures were computed, formatted; for the "stored" caption. */
  storedAt: string | null;
}) {
  const [t, cadences, formatMoney] = await Promise.all([
    getTranslations('reports'),
    getTranslations('recurring.cadence'),
    getFormatMoney(),
  ]);
  const money = (minor: number) => formatMoney(Math.abs(minor), currency, locale);

  function describe(a: AnomalyDto): { title: string; name: string; figures: ReactNode } {
    switch (a.type) {
      case 'category_spike':
        return {
          title: t('anomaly.spike', { name: a.name }),
          name: a.name,
          figures: t('anomaly.spikeFig', { amount: money(a.amount), baseline: money(a.baseline) }),
        };
      case 'budget_overrun':
        return {
          title: t('anomaly.overrun', { name: a.name }),
          name: a.name,
          figures: t.rich('anomaly.overrunFig', {
            actual: money(a.actual),
            planned: money(a.planned),
            over: money(a.actual - a.planned),
            // The word "acima" already says it is over; the colour is a second cue.
            neg: (chunks) => <span className="text-negative">{chunks}</span>,
          }),
        };
      case 'new_recurring':
        return {
          title: t('anomaly.newRecurring', { name: a.name }),
          name: a.name,
          figures: t('anomaly.newRecurringFig', {
            amount: money(a.amount),
            cadence: (CADENCES as readonly string[]).includes(a.cadence)
              ? cadences(a.cadence as (typeof CADENCES)[number])
              : a.cadence,
          }),
        };
      case 'recurring_price_change':
        return {
          title: t('anomaly.priceChange', { name: a.name }),
          name: a.name,
          figures: (
            <>
              <span aria-hidden="true">
                {money(a.before)} → {money(a.after)}
              </span>
              <span className="sr-only">
                {t('anomaly.priceChangeSr', { before: money(a.before), after: money(a.after) })}
              </span>
            </>
          ),
        };
      case 'large_transaction':
        return {
          title: t('anomaly.large', { categoryName: a.categoryName }),
          name: a.categoryName,
          figures: t('anomaly.largeFig', {
            amount: money(a.amount),
            date: formatDate(a.date, locale),
          }),
        };
    }
  }

  const heading = (count: number | null) => (
    <>
      {t('anomaly.title')}
      {count !== null ? (
        <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-surface-3 px-1.5 align-middle text-caption font-semibold tabular-nums text-muted-foreground">
          {count}
        </span>
      ) : null}
    </>
  );

  if (data.kind === 'error') {
    return (
      <Card
        as="section"
        aria-labelledby="report-anomalies-title"
        data-testid="report-anomalies"
        className="h-fit"
      >
        <CardHeader title={heading(null)} titleId="report-anomalies-title" />
        <p className="text-base text-muted-foreground">{t('anomaly.error')}</p>
      </Card>
    );
  }

  const caption =
    data.source === 'stored' && storedAt
      ? t('anomaly.stored', { datetime: storedAt })
      : t('anomaly.live');

  return (
    <Card
      as="section"
      aria-labelledby="report-anomalies-title"
      data-testid="report-anomalies"
      className="h-fit"
    >
      <CardHeader
        title={heading(data.items.length)}
        titleId="report-anomalies-title"
        description={caption}
      />
      {data.items.length === 0 ? (
        <p className="text-base text-muted-foreground">
          {t('anomaly.empty', { month: monthLabel })}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {data.items.map((a, i) => {
            const text = describe(a);
            const link = anomalyLink(a, month, role);
            const linkLabel = link
              ? link.kind === 'movements'
                ? t('anomaly.viewTx')
                : link.kind === 'line'
                  ? t('anomaly.viewLine')
                  : t('anomaly.viewRecurring')
              : null;
            return (
              <li
                key={i}
                data-testid="anomaly"
                className="grid min-h-14 grid-cols-1 gap-1 py-3 first:pt-0 last:pb-0"
              >
                <p className="wrap-anywhere text-base font-medium">{text.title}</p>
                <p className="wrap-anywhere text-sm tabular-nums text-muted-foreground">
                  {text.figures}
                </p>
                {link && linkLabel ? (
                  <Link
                    href={link.href}
                    className="inline-flex min-h-11 w-fit items-center gap-0.5 rounded-md text-sm font-medium text-primary-text underline-offset-4 hover:underline md:pointer-fine:min-h-8"
                  >
                    <span>
                      {linkLabel}
                      <span className="sr-only">{t('anomaly.linkSr', { name: text.name })}</span>
                    </span>
                    <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function AnomaliesSkeleton() {
  return <Skeleton className="h-64 w-full rounded-lg" />;
}
