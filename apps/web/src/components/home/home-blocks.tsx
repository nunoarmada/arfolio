import { Link2, ReceiptText, ScanSearch } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { HomeAccounts } from '@/components/accounts/home-accounts';
import { HomeBudgetCard, HomeBudgetError, HomeNoBudgetCard } from '@/components/budget/home-card';
import { HomeUpcoming } from '@/components/budget/home-upcoming';
import { Landmark, PiggyBank, Receipt, TrendingUp, type LucideIcon } from 'lucide-react';
import { ConnectionBanner } from '@/components/connections/connection-banner';
import { NetWorthHomeCard } from '@/components/net-worth/home-card';
import { connectionStatus, isBlocking, needsAttention } from '@/lib/connection-status';
import type { HomeBudget } from '@/server/budget-data';
import type {
  HomeAccounts as HomeAccountsData,
  HomeConnections,
  HomeMonthSpend,
  HomeReview,
  HomeUpcoming as HomeUpcomingData,
} from '@/server/home-data';
import type { HomeNetWorth } from '@/server/net-worth-data';
import { BlockError } from './block-frame';
import { KpiTile } from '@/components/ui/kpi-tile';
import { AvailableKpi, NetWorthKpi, SavingsKpi, SpendKpi } from './kpi-tiles';
import { TodoCard, TodoErrorRow, type TodoItem } from './todo-card';

/**
 * Each block awaits its own promise inside its own Suspense boundary, so a slow or failed block
 * never holds the others back. The promises are started by the page and never reject: every
 * loader turns a failure into `{ kind: 'error' }`.
 */

export async function ConnectionBannerBlock({
  connections,
  now,
  timeZone,
}: {
  connections: Promise<HomeConnections>;
  now: Date;
  timeZone: string;
}) {
  const result = await connections;
  // A failure is shown by the "Contas e ligações" block; the banner just stays away.
  if (result.kind === 'error') return null;
  return <ConnectionBanner connections={result.connections} now={now} timeZone={timeZone} />;
}

export async function BudgetBlock({
  budget,
  monthSpend,
  today,
  canWrite,
}: {
  budget: Promise<HomeBudget>;
  /** Started lazily: only a household without a budget needs it. */
  monthSpend: () => Promise<HomeMonthSpend>;
  today: string;
  canWrite: boolean;
}) {
  const result = await budget;
  if (result.kind === 'error') return <HomeBudgetError />;
  if (result.kind === 'ready') {
    return (
      <HomeBudgetCard
        view={result.view}
        month={result.month}
        pace={result.pace}
        today={today}
        unbudgeted={result.unbudgeted}
      />
    );
  }
  const spent = await monthSpend();
  if (spent.kind === 'error') return <HomeBudgetError />;
  return <HomeNoBudgetCard spent={spent} canWrite={canWrite} />;
}

/** A tile whose data could not be loaded: the label stays, the value is a dash. */
async function KpiUnavailable({
  label,
  icon,
  href,
}: {
  label: string;
  icon: LucideIcon;
  href: string;
}) {
  const t = await getTranslations('home.kpi');
  return (
    <KpiTile
      label={label}
      icon={icon}
      href={href}
      value={
        <span className="text-[26px] font-semibold leading-8 text-muted-foreground max-sm:text-[22px] max-sm:leading-7 max-[389px]:text-[20px]">
          <span aria-hidden="true">—</span>
          <span className="sr-only">{t('unavailable')}</span>
        </span>
      }
    />
  );
}

export async function AvailableKpiBlock({ accounts }: { accounts: HomeAccountsData }) {
  const t = await getTranslations('home.kpi');
  if (accounts.kind === 'error') {
    return <KpiUnavailable label={t('available')} icon={Landmark} href="/accounts" />;
  }
  return (
    <AvailableKpi
      available={accounts.available}
      count={accounts.availableCount}
      currency={accounts.currency}
      otherCurrency={accounts.otherCurrency}
      segments={accounts.items
        .filter((a) => a.available && a.balance > 0)
        .sort((a, b) => b.balance - a.balance)
        .map((a) => ({ name: a.name, value: a.balance }))}
    />
  );
}

export async function SpendKpiBlock({
  budget,
  monthSpend,
}: {
  budget: Promise<HomeBudget>;
  monthSpend: () => Promise<HomeMonthSpend>;
}) {
  const [result, t] = await Promise.all([budget, getTranslations('home.kpi')]);
  if (result.kind === 'ready') {
    return <SpendKpi view={result.view} pace={result.pace} spent={0} />;
  }
  const spent = result.kind === 'none' ? await monthSpend() : ({ kind: 'error' } as const);
  if (spent.kind === 'error') {
    return <KpiUnavailable label={t('spent')} icon={Receipt} href="/budget" />;
  }
  return <SpendKpi view={null} pace={null} spent={spent.expense} />;
}

export async function SavingsKpiBlock({
  budget,
  monthSpend,
}: {
  budget: Promise<HomeBudget>;
  monthSpend: () => Promise<HomeMonthSpend>;
}) {
  const [result, t] = await Promise.all([budget, getTranslations('home.kpi')]);
  if (result.kind === 'ready') return <SavingsKpi view={result.view} income={0} expense={0} />;
  const spent = result.kind === 'none' ? await monthSpend() : ({ kind: 'error' } as const);
  if (spent.kind === 'error') {
    return (
      <KpiUnavailable
        label={t(result.kind === 'none' ? 'flow' : 'savings')}
        icon={result.kind === 'none' ? TrendingUp : PiggyBank}
        href="/budget"
      />
    );
  }
  return <SavingsKpi view={null} income={spent.income} expense={spent.expense} />;
}

export async function NetWorthKpiBlock({
  netWorth,
  currentMonth,
}: {
  netWorth: Promise<HomeNetWorth>;
  currentMonth: string;
}) {
  const [data, t] = await Promise.all([netWorth, getTranslations('home.kpi')]);
  if (data.kind === 'error') {
    return <KpiUnavailable label={t('netWorth')} icon={TrendingUp} href="/net-worth" />;
  }
  return <NetWorthKpi data={data} currentMonth={currentMonth} />;
}

/**
 * "Para fazer": the review count, the connections that need attention (blocking ones have the
 * banner above) and the recurring payments waiting for a decision. Each comes from its own
 * loader; one that failed leaves its own row out and shows its own error elsewhere.
 */
export async function TodoBlock({
  review,
  connections,
  upcoming,
  canWrite,
  now,
  timeZone,
}: {
  review: Promise<HomeReview>;
  connections: Promise<HomeConnections>;
  upcoming: Promise<HomeUpcomingData>;
  /** Reviewing and confirming are writes: viewers read the sentences only. */
  canWrite: boolean;
  now: Date;
  timeZone: string;
}) {
  const [reviewResult, conns, ups, t] = await Promise.all([
    review,
    connections,
    upcoming,
    getTranslations('home'),
  ]);
  const items: TodoItem[] = [];
  const errors = [];
  if (reviewResult.kind === 'error') {
    errors.push(
      <TodoErrorRow
        key="review-error"
        testId="home-review"
        text={t('reviewError')}
        retry={t('retry')}
      />,
    );
  } else if (reviewResult.count > 0) {
    items.push({
      key: 'review',
      testId: 'home-review',
      icon: ScanSearch,
      text: t('review', { count: reviewResult.count }),
      action: canWrite ? { href: '/transactions/review', label: t('reviewAction') } : undefined,
    });
  }
  if (conns.kind === 'ready') {
    const attention = conns.connections.filter((c) => {
      const key = connectionStatus(c, now, timeZone).key;
      return needsAttention(key) && !isBlocking(key);
    }).length;
    if (attention > 0) {
      items.push({
        key: 'connections',
        icon: Link2,
        tone: 'warning',
        text: t('todo.connections', { count: attention }),
        action: { href: '/connections', label: t('todo.connectionsAction') },
      });
    }
  }
  if (ups.kind === 'ready' && ups.detected > 0) {
    items.push({
      key: 'subscriptions',
      icon: ReceiptText,
      text: t('todo.subscriptions', { count: ups.detected }),
      action: canWrite
        ? { href: '/budget/subscriptions', label: t('todo.subscriptionsAction') }
        : undefined,
    });
  }
  return <TodoCard items={items} errors={errors} />;
}

export async function UpcomingBlock({
  upcoming,
  canWrite,
}: {
  upcoming: Promise<HomeUpcomingData>;
  canWrite: boolean;
}) {
  const [result, t] = await Promise.all([upcoming, getTranslations('home')]);
  if (result.kind === 'error') {
    return (
      <BlockError
        titleId="home-upcoming-title"
        title={t('upcoming.title')}
        message={t('upcoming.error')}
        retry={t('retry')}
        link={{ href: '/budget/subscriptions', label: t('upcoming.see') }}
        className="min-h-[148px]"
      />
    );
  }
  if (result.view.kind === 'hidden') return null;
  return <HomeUpcoming view={result.view} today={result.today} canWrite={canWrite} />;
}

export async function NetWorthBlock({
  netWorth,
  currentMonth,
}: {
  netWorth: Promise<HomeNetWorth>;
  currentMonth: string;
}) {
  return <NetWorthHomeCard data={await netWorth} currentMonth={currentMonth} />;
}

export async function AccountsBlock({
  accounts,
  connections,
  now,
  locale,
  timeZone,
}: {
  accounts: HomeAccountsData;
  connections: Promise<HomeConnections>;
  now: Date;
  locale: string;
  timeZone: string;
}) {
  const [conns, t] = await Promise.all([connections, getTranslations('home')]);
  if (accounts.kind === 'error' || conns.kind === 'error') {
    return (
      <BlockError
        titleId="home-accounts-title"
        title={t('accounts.title')}
        message={t('accounts.error')}
        retry={t('retry')}
        className="min-h-[88px]"
      />
    );
  }
  return (
    <HomeAccounts
      available={accounts.available}
      currency={accounts.currency}
      otherCurrency={accounts.otherCurrency}
      items={accounts.items}
      connections={conns.connections}
      now={now}
      locale={locale}
      timeZone={timeZone}
    />
  );
}
