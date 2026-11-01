'use client';

import { CalendarClock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { upcomingDayLabel, type UpcomingView } from '@/lib/home-upcoming';
import { buttonVariants } from '../ui/button';
import { Card, CardHeader, IconTile } from '../ui/card';
import { cn } from '@/lib/cn';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { useFormatMoney } from '@/components/privacy';

const MINUS = '−';

/**
 * The confirmed payments of the next seven days. With nothing confirmed the block says so (and
 * offers the detections to those who can confirm them); with no recurring items at all it is not
 * there. Rows are not links: "Ver subscrições" is the way in.
 */
export function HomeUpcoming({
  view,
  today,
  canWrite,
}: {
  view: Exclude<UpcomingView, { kind: 'hidden' }>;
  today: string;
  canWrite: boolean;
}) {
  const t = useTranslations('home.upcoming');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  return (
    <Card
      as="section"
      data-testid="home-upcoming"
      aria-labelledby="home-upcoming-title"
      className="flex flex-col"
    >
      <CardHeader
        title={t('title')}
        titleId="home-upcoming-title"
        description={t('range')}
        link={{ href: '/budget/subscriptions', label: t('see') }}
      />
      {view.kind === 'list' ? (
        <>
          <ul className="-mx-4 divide-y border-t md:-mx-5 xl:-mx-6">
            {view.rows.map((item) => {
              const label = upcomingDayLabel(item.nextExpectedOn!, today, locale, {
                today: t('today'),
                tomorrow: t('tomorrow'),
              });
              const soon = item.nextExpectedOn === today;
              return (
                <li
                  key={item.id}
                  className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2.5 md:px-5 xl:px-6"
                >
                  <span
                    className="line-clamp-2 min-w-0 break-words text-base font-medium"
                    title={item.name}
                  >
                    {item.name}
                  </span>
                  <MoneyAmount
                    minor={Math.abs(item.amount)}
                    currency={item.currency}
                    kind="expense"
                    className="shrink-0 font-semibold"
                  />
                  <span
                    className={cn(
                      'col-span-2 text-label font-normal tabular-nums',
                      soon ? 'font-medium text-primary-text' : 'text-muted-foreground',
                    )}
                  >
                    {label}
                  </span>
                </li>
              );
            })}
            {view.more > 0 ? (
              <li>
                <Link
                  href="/budget/subscriptions"
                  className="flex min-h-11 items-center px-4 py-2 text-sm font-medium text-primary-text hover:bg-surface-2 hover:underline md:px-5 xl:px-6"
                >
                  {t('more', { count: view.more })}
                </Link>
              </li>
            ) : null}
          </ul>
          <p className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t pt-3 text-sm text-muted-foreground">
            {view.total !== null ? (
              <span className="tabular-nums">
                {t('total', {
                  amount: `${MINUS}${formatMoney(view.total, currency, locale)}`,
                })}
              </span>
            ) : null}
            {view.foreign > 0 ? <span>{t('foreign', { count: view.foreign })}</span> : null}
          </p>
        </>
      ) : view.kind === 'toConfirm' ? (
        <div className="flex flex-1 flex-wrap content-center items-center justify-between gap-3">
          <p className="flex min-w-0 items-center gap-3 text-sm text-muted-foreground">
            <IconTile icon={CalendarClock} />
            <span className="min-w-0">{t('toConfirm', { count: view.detected })}</span>
          </p>
          {canWrite ? (
            <Link
              href="/budget/subscriptions"
              className={cn(buttonVariants({ variant: 'outline' }))}
            >
              {t('confirm')}
            </Link>
          ) : null}
        </div>
      ) : (
        <p className="flex flex-1 items-center gap-3 text-sm text-muted-foreground">
          <IconTile icon={CalendarClock} tone="neutral" />
          <span>{t('empty')}</span>
        </p>
      )}
    </Card>
  );
}
