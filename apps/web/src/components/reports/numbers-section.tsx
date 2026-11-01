import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { addMonths, monthName } from '@/lib/dates';
import { signedMoney } from '@/lib/insights-format';
import { getFormatMoney } from '@/server/format-money';
import { insightsHref } from '@/lib/insights-chart';
import type { Money4, NumbersDto } from '@/server/reports-data';
import { MoneyAmount } from '../money-amount';
import { TableRegion } from '../insights/section-card';
import { Card, CardHeader } from '../ui/card';
import { dataTable } from '../ui/data-table';
import { cn } from '@/lib/cn';

/** Declared here (not imported from the client module that holds `TableRegion`) so they stay strings. */
const TH = cn(dataTable.th, 'text-left');
const TH_FIRST = cn(TH, dataTable.stickyFirstHead);
const ROW_HEAD = cn(
  'sticky left-0 z-10 whitespace-nowrap bg-inherit px-3 py-2 text-left text-sm font-normal',
  'group-data-[start=false]/scroll:shadow-[1px_0_0_var(--border-strong),6px_0_8px_-6px_var(--edge-shadow)]',
);

const ROWS = ['income', 'expense', 'saving', 'net'] as const;

const capitalise = (s: string, locale: string) =>
  s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);

/**
 * The month's totals next to the month before and the three-month average, as a real table, with
 * net worth and the recurring cost under it. All figures come from the facts stored with the
 * report, so they are what the AI text was written from.
 */
export async function NumbersSection({
  data,
  month,
  monthLabel,
  locale,
  currentMonth,
}: {
  data: NumbersDto;
  month: string;
  monthLabel: string;
  locale: string;
  /** The first day of the current month, as the charts page defaults to it. */
  currentMonth: string;
}) {
  const [t, foreign, formatMoney] = await Promise.all([
    getTranslations('reports.numbers'),
    getTranslations('insights'),
    getFormatMoney(),
  ]);
  const iso = `${month}-01`;
  const columns: Array<{ key: string; label: string; values: Money4 }> = [
    { key: 'now', label: capitalise(monthName(iso, locale), locale), values: data.totals },
    {
      key: 'prev',
      label: capitalise(monthName(addMonths(iso, -1), locale), locale),
      values: data.previous,
    },
    { key: 'avg3', label: t('avg3'), values: data.avg3 },
  ];
  const signed = (minor: number) =>
    signedMoney(formatMoney, minor, data.currency, locale, { plus: true });

  return (
    <Card
      as="section"
      aria-labelledby="report-numbers-title"
      data-testid="report-numbers"
      className="grid grid-cols-1 gap-4"
    >
      <CardHeader title={t('title')} titleId="report-numbers-title" className="mb-0 md:mb-0" />

      {/* Phones: one block per figure, the three columns as a definition list. */}
      <ul className="grid grid-cols-1 gap-2 md:hidden">
        {ROWS.map((row) => (
          <li key={row} className="rounded-md bg-surface-2 p-3">
            <p className="mb-2 text-sm font-semibold">{t(row)}</p>
            <dl className="grid grid-cols-1 gap-1.5">
              {columns.map((c) => (
                <div key={c.key} className="flex items-baseline justify-between gap-3">
                  <dt className="text-sm text-muted-foreground">{c.label}</dt>
                  <dd>
                    <MoneyAmount
                      minor={c.values[row]}
                      currency={data.currency}
                      kind="balance"
                      size="sm"
                    />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
      <div className="hidden md:block">
        <TableRegion label={t('caption', { month: monthLabel })} compact>
          <thead>
            <tr className="bg-surface-2">
              <th scope="col" className={TH_FIRST}>
                <span className="sr-only">{t('metric')}</span>
              </th>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={cn(TH, 'whitespace-nowrap text-right')}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {ROWS.map((row) => (
              <tr key={row} className="bg-surface">
                <th scope="row" className={ROW_HEAD}>
                  {t(row)}
                </th>
                {columns.map((c) => (
                  <td key={c.key} className="px-3 py-2 text-right">
                    <MoneyAmount
                      minor={c.values[row]}
                      currency={data.currency}
                      kind="balance"
                      size="sm"
                      className="justify-end"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </TableRegion>
      </div>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card variant="inset" pad="sm" className="grid grid-cols-1 content-start gap-1">
          <dt className="text-label text-muted-foreground">{t('netWorth')}</dt>
          <dd className="grid grid-cols-1 gap-0.5 text-sm">
            <MoneyAmount
              minor={data.netWorth.now}
              currency={data.currency}
              kind="balance"
              size="lg"
            />
            <span className="text-muted-foreground">
              {t('nwMonth', { amount: signed(data.netWorth.changeMonth) })}
            </span>
            {data.netWorth.change12m !== null ? (
              <span className="text-muted-foreground">
                {t('nw12', { amount: signed(data.netWorth.change12m) })}
              </span>
            ) : null}
          </dd>
        </Card>
        <Card variant="inset" pad="sm" className="grid grid-cols-1 content-start gap-1">
          <dt className="text-label text-muted-foreground">{t('recurring')}</dt>
          <dd>
            <MoneyAmount
              minor={data.recurringMonthlyCost}
              currency={data.currency}
              kind="neutral"
              size="lg"
            />
          </dd>
        </Card>
      </dl>

      {data.otherCurrencyCount > 0 ? (
        <p className="text-sm text-muted-foreground">
          {foreign('foreign', { count: data.otherCurrencyCount })}
        </p>
      ) : null}
      <Link
        href={insightsHref({ range: 1, end: iso, account: null }, currentMonth)}
        className="inline-flex min-h-11 w-fit items-center text-base font-medium text-primary-text underline-offset-4 hover:underline md:pointer-fine:min-h-8"
      >
        {t('charts', { month: monthLabel })}
      </Link>
    </Card>
  );
}
