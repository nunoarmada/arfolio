import { getTranslations } from 'next-intl/server';
import { trimLeadingEmpty, type InsightsParams } from '@/lib/insights-chart';
import type { PeriodWords } from '@/lib/insights-format';
import type { InsightsCashFlow, InsightsSpending, InsightsTrends } from '@/server/insights-data';
import { CashFlow } from './cash-flow';
import { PeriodKpis } from './period-kpis';
import { SectionError } from './section-error';
import { SpendingByGroup } from './spending-by-group';
import { TrendsChart } from './trends-chart';

/**
 * Each section awaits its own promise inside its own Suspense boundary, so a slow or failed
 * section never holds the others back. The promises are started by the page and never reject:
 * every loader turns a failure into `{ kind: 'error' }`.
 */

export async function SpendingBlock({
  result,
  from,
  to,
  words,
  retryHref,
}: {
  result: Promise<InsightsSpending>;
  from: string;
  to: string;
  words: PeriodWords;
  retryHref: string;
}) {
  const [data, t] = await Promise.all([result, getTranslations('insights')]);
  if (data.kind === 'error') {
    return (
      <SectionError
        testId="insights-spending"
        title={t('spending.title')}
        section={t('sections.spending')}
        href={retryHref}
      />
    );
  }
  return (
    <SpendingByGroup data={data} from={from} to={to} words={words} title={t('spending.title')} />
  );
}

export async function CashFlowBlock({
  result,
  params,
  from,
  to,
  currentMonth,
  retryHref,
}: {
  result: Promise<InsightsCashFlow>;
  params: InsightsParams;
  from: string;
  to: string;
  currentMonth: string;
  retryHref: string;
}) {
  const [data, t] = await Promise.all([result, getTranslations('insights')]);
  if (data.kind === 'error') {
    return (
      <SectionError
        testId="insights-cashflow"
        title={t('cashFlow.title')}
        section={t('sections.cashFlow')}
        href={retryHref}
      />
    );
  }
  return (
    <CashFlow
      data={data}
      params={{ ...params, account: data.account }}
      from={from}
      to={to}
      currentMonth={currentMonth}
      title={t('cashFlow.title')}
    />
  );
}

export async function TrendsBlock({
  result,
  selected,
  currentMonth,
  retryHref,
}: {
  result: Promise<InsightsTrends>;
  selected: readonly string[];
  currentMonth: string;
  retryHref: string;
}) {
  const [data, t] = await Promise.all([result, getTranslations('insights')]);
  if (data.kind === 'error') {
    return (
      <SectionError
        testId="insights-trends"
        title={t('trends.title')}
        section={t('sections.trends')}
        href={retryHref}
      />
    );
  }
  return (
    <TrendsChart
      rows={trimLeadingEmpty(data.rows)}
      selected={selected}
      currentMonth={currentMonth}
      title={t('trends.title')}
    />
  );
}

/** The KPI strip. It waits for the same trends promise as the chart; if that fails, it just isn't shown. */
export async function KpisBlock({
  result,
  months,
  currentMonth,
}: {
  result: Promise<InsightsTrends>;
  months: readonly string[];
  currentMonth: string;
}) {
  const data = await result;
  if (data.kind === 'error') return null;
  return <PeriodKpis rows={data.rows} months={months} currentMonth={currentMonth} />;
}
