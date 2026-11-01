'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { EmptyState } from '@/components/empty-state';
import { buttonVariants, Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Card } from '@/components/ui/card';
import { monthName } from '@/lib/dates';
import {
  DEFAULT_PERIOD,
  emptyFilters,
  filtersToParams,
  type Period,
  type TxFilters,
} from '@/lib/transaction-filters';
import {
  categoriseAction,
  getTransactionAction,
  loadTransactionsPageAction,
  undoAiCategorisationAction,
} from '@/server/actions/transactions';
import type { AccountDto, CategoryDto, GroupDto, TxDto } from '@/server/serialize';
import type { TxPageDto } from '@/server/transactions-data';
import { useHouseholdFormat } from '../household-format';
import { useToast } from '../ui/toast';
import { useFailureMessage, useReportFailure } from '../use-action-error';
import { DayGroup } from './day-group';
import { FilterBar } from './filter-bar';
import { ManualTransactionSheet } from './manual-transaction-sheet';
import { TransactionRow } from './transaction-row';
import { TransactionSheet } from './transaction-sheet';
import { useSentinel } from './use-sentinel';

interface Group {
  date: string;
  items: TxDto[];
}

function groupByDay(items: TxDto[]): Group[] {
  const groups: Group[] = [];
  for (const item of items) {
    const last = groups.at(-1);
    if (last && last.date === item.purchaseDate) last.items.push(item);
    else groups.push({ date: item.purchaseDate, items: [item] });
  }
  return groups;
}

/** The day's net: booked, non-transfer rows, and only when they share one currency. */
function dayTotal(items: TxDto[]): { total: number; currency: string } | null {
  const counted = items.filter((i) => i.status === 'booked' && !i.transferGroupId);
  if (counted.length === 0) return null;
  const currency = counted[0]!.currency;
  if (counted.some((i) => i.currency !== currency)) return null;
  return { total: counted.reduce((sum, i) => sum + i.amount, 0), currency };
}

export function ListSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4" aria-hidden="true">
      {[0, 1, 2].map((g) => (
        <div key={g} className="grid grid-cols-1 rounded-lg bg-surface shadow-card">
          <Skeleton className="h-9 rounded-b-none" />
          <div className="divide-y divide-border">
            {[0, 1, 2, 3].map((r) => (
              <div key={r} className="flex min-h-15 items-center gap-3 px-4 py-2 md:min-h-14">
                <Skeleton className="size-9 rounded-full" />
                <div className="grid grid-cols-1 flex-1 gap-1.5">
                  <Skeleton className="h-4 w-2/5" />
                  <Skeleton className="h-3.5 w-1/4" />
                </div>
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The movements list: filters in the URL, day groups with infinite scroll (cursor pages of 50),
 * the detail sheet and, for members, "add manual movement". Used on /transactions and, locked to
 * one account, on the account page.
 */
export function TransactionsView({
  initial,
  filters,
  today,
  accounts,
  groups,
  categories,
  recentIds,
  canWrite,
  basePath,
  lockAccountId,
  defaultPeriod = DEFAULT_PERIOD,
  resetKey,
  openManual = false,
  showAiFilter = false,
}: {
  initial: TxPageDto;
  filters: TxFilters;
  today: string;
  accounts: AccountDto[];
  groups: GroupDto[];
  categories: CategoryDto[];
  recentIds: string[];
  canWrite: boolean;
  basePath: string;
  lockAccountId?: string;
  /** The period shown when the URL names none (the account page shows all time). */
  defaultPeriod?: Period;
  /** When this changes the list starts again from `initial` (new filters, or data changed elsewhere). */
  resetKey: string;
  /** The header's "Adicionar > Movimento manual" asked for the entry sheet (`?add=manual`). */
  openManual?: boolean;
  /** Offer the "Categorizados por IA" filter (AI is on, or AI rows exist). */
  showAiFilter?: boolean;
}) {
  const t = useTranslations('transactions');
  const aiT = useTranslations('ai');
  const toast = useToast();
  const common = useTranslations('common');
  const router = useRouter();
  const { locale } = useHouseholdFormat();
  const failure = useFailureMessage();
  const report = useReportFailure();
  const [pending, startTransition] = useTransition();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [items, setItems] = useState<TxDto[]>(initial.items);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  // New filters bring a new first page: start over (without remounting, so the search box keeps focus).
  const [seenReset, setSeenReset] = useState(resetKey);
  if (seenReset !== resetKey) {
    setSeenReset(resetKey);
    setItems(initial.items);
    setCursor(initial.nextCursor);
    setLoadError(null);
  }
  const [selected, setSelected] = useState<TxDto | null>(null);

  const effective = useMemo<TxFilters>(
    () => (lockAccountId ? { ...filters, accountIds: [lockAccountId] } : filters),
    [filters, lockAccountId],
  );
  const query = filtersToParams(effective, defaultPeriod).toString();

  const [manualOpen, setManualOpen] = useState(openManual);
  useEffect(() => {
    if (openManual) setManualOpen(true);
  }, [openManual]);
  const closeManual = useCallback(
    (open: boolean) => {
      setManualOpen(open);
      if (!open && openManual) {
        const params = filtersToParams(effective, defaultPeriod).toString();
        router.replace(params ? `${basePath}?${params}` : basePath, { scroll: false });
      }
    },
    [basePath, defaultPeriod, effective, openManual, router],
  );

  const apply = useCallback(
    (next: TxFilters) => {
      const params = filtersToParams(
        lockAccountId ? { ...next, accountIds: [] } : next,
        defaultPeriod,
      ).toString();
      startTransition(() =>
        router.replace(params ? `${basePath}?${params}` : basePath, { scroll: false }),
      );
    },
    [basePath, defaultPeriod, lockAccountId, router],
  );

  const loadMore = useCallback(async () => {
    if (!cursor || loading) return;
    setLoading(true);
    setLoadError(null);
    const result = await loadTransactionsPageAction(query, cursor, defaultPeriod);
    setLoading(false);
    if (!result.ok) return setLoadError(failure(result));
    setItems((cur) => {
      const seen = new Set(cur.map((i) => i.id));
      return [...cur, ...result.data.items.filter((i) => !seen.has(i.id))];
    });
    setCursor(result.data.nextCursor);
  }, [cursor, defaultPeriod, failure, loading, query]);

  const reload = useCallback(async () => {
    const result = await loadTransactionsPageAction(query, null, defaultPeriod);
    if (!result.ok) return setLoadError(failure(result));
    setItems(result.data.items);
    setCursor(result.data.nextCursor);
  }, [defaultPeriod, failure, query]);

  const sentinel = useSentinel<HTMLDivElement>(
    cursor !== null && !loading && !loadError,
    () => void loadMore(),
  );

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const dayGroups = useMemo(() => groupByDay(items), [items]);
  const activeAccounts = accounts.filter((a) => !a.archived);

  const update = useCallback((tx: TxDto) => {
    setItems((cur) => cur.map((i) => (i.id === tx.id ? tx : i)));
    setSelected((cur) => (cur?.id === tx.id ? tx : cur));
  }, []);

  // One-tap undo in the `?by=ai` list: the row collapses (180 ms) and focus moves on.
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const aiList = filters.by === 'ai';
  const undoAi = useCallback(
    async (tx: TxDto) => {
      const visible = items.filter((i) => !leaving.has(i.id));
      const at = visible.findIndex((i) => i.id === tx.id);
      const next = visible[at + 1] ?? visible[at - 1];
      const result = await undoAiCategorisationAction(tx.id);
      if (!result.ok) {
        if (result.code === 'ai_changed') toast.error(aiT('changed'));
        else report(result);
        return;
      }
      const restored = result.data;
      setLeaving((cur) => new Set(cur).add(tx.id));
      window.setTimeout(() => {
        setItems((cur) => cur.filter((i) => i.id !== tx.id));
        setLeaving((cur) => {
          const nextSet = new Set(cur);
          nextSet.delete(tx.id);
          return nextSet;
        });
        requestAnimationFrame(() => {
          const target = next
            ? document.querySelector<HTMLElement>(`[data-undo="${next.id}"]`)
            : document.querySelector<HTMLElement>('main h1');
          if (target && !next) target.tabIndex = -1;
          target?.focus();
        });
      }, 180);
      toast.success(aiT('undone'), {
        label: t('undo'),
        onClick: () => {
          const suggested = restored.aiSuggestedCategoryId;
          if (!suggested) return;
          void categoriseAction({ id: tx.id, categoryId: suggested, applyToMerchant: false }).then(
            (r) => {
              if (!r.ok) return report(r);
              void reload();
            },
          );
        },
      });
    },
    [aiT, items, leaving, reload, report, t, toast],
  );

  const empty = (() => {
    if (filters.q) {
      return (
        <EmptyState title={t('emptySearch', { query: filters.q })}>
          <Button variant="outline" onClick={() => apply({ ...filters, q: '' })}>
            {t('clearSearch')}
          </Button>
        </EmptyState>
      );
    }
    // "All time" widens the list: an empty list with only that choice is just empty.
    const narrowed =
      filters.accountIds.length > 0 ||
      filters.categoryIds.length > 0 ||
      filters.review ||
      filters.booked ||
      filters.excludeTransfers ||
      filters.transfersOnly ||
      aiList ||
      (filters.period !== defaultPeriod && filters.period !== 'all');
    if (narrowed) {
      return (
        <EmptyState title={aiList ? aiT('emptyFiltered') : t('emptyFiltered')}>
          <Button variant="outline" onClick={() => apply(emptyFilters(defaultPeriod))}>
            {t('clearFilters')}
          </Button>
        </EmptyState>
      );
    }
    return (
      <EmptyState
        title={
          filters.period === 'this-month'
            ? t('emptyMonth', { month: monthName(today, locale) })
            : t('emptyPeriod')
        }
        action={
          canWrite ? (
            <Link
              href={lockAccountId ? `/import?account=${lockAccountId}` : '/import'}
              className={buttonVariants({ variant: 'outline' })}
            >
              {t('addImport')}
            </Link>
          ) : undefined
        }
      />
    );
  })();

  return (
    <div className="grid grid-cols-1 gap-4">
      <FilterBar
        filters={filters}
        defaultPeriod={defaultPeriod}
        onChange={apply}
        accounts={accounts}
        groups={groups}
        lockAccount={lockAccountId !== undefined}
        showAiFilter={showAiFilter}
      />

      <div aria-busy={pending} className={pending ? 'opacity-60 transition-opacity' : undefined}>
        {items.length === 0 ? (
          empty
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:gap-4">
            <div
              aria-hidden="true"
              className={`hidden grid-cols-[2.25rem_minmax(0,2fr)_minmax(0,1fr)_minmax(10rem,1fr)_9rem] gap-x-3 px-4 text-label font-medium text-muted-foreground lg:grid ${aiList && canWrite ? 'lg:pr-[4.25rem]' : ''}`}
            >
              <span />
              <span>{t('col.description')}</span>
              <span>{t('col.category')}</span>
              <span>{t('col.account')}</span>
              <span className="text-right">{t('col.amount')}</span>
            </div>
            <Card
              pad="none"
              className="[&>section:first-child>h3]:rounded-t-lg [&>section:last-child>ul]:rounded-b-lg"
            >
              {dayGroups.map((g, index) => {
                const partial = index === dayGroups.length - 1 && cursor !== null;
                const total = partial ? null : dayTotal(g.items);
                return (
                  <DayGroup
                    key={g.date}
                    date={g.date}
                    today={today}
                    total={total?.total ?? null}
                    currency={total?.currency ?? null}
                  >
                    {g.items.map((tx) => (
                      <li
                        key={tx.id}
                        className={`grid grid-cols-1 transition-[grid-template-rows,opacity] duration-[180ms] ease-out ${
                          leaving.has(tx.id)
                            ? 'grid-rows-[0fr] opacity-0'
                            : 'grid-rows-[1fr] opacity-100'
                        }`}
                      >
                        <div className="min-h-0 overflow-hidden">
                          <TransactionRow
                            tx={tx}
                            category={tx.categoryId ? categoryById.get(tx.categoryId) : undefined}
                            account={accountById.get(tx.accountId)}
                            onOpen={() => setSelected(tx)}
                            search={filters.q}
                            signedTransfers={lockAccountId !== undefined}
                            {...(aiList && canWrite && tx.categorisedBy === 'ai'
                              ? { onUndoAi: () => void undoAi(tx) }
                              : {})}
                          />
                        </div>
                      </li>
                    ))}
                  </DayGroup>
                );
              })}
            </Card>
            {cursor ? (
              <div ref={sentinel} className="grid grid-cols-1 gap-3">
                {loading ? (
                  <p role="status" className="text-center text-sm text-muted-foreground">
                    {t('loadingMore')}
                  </p>
                ) : null}
                {loadError ? <Alert tone="error">{loadError}</Alert> : null}
                <Button
                  variant="outline"
                  onClick={() => void loadMore()}
                  loading={loading}
                  className="justify-self-center"
                >
                  {loadError ? common('retry') : t('loadMore')}
                </Button>
              </div>
            ) : (
              <p className="py-2 text-center text-sm text-muted-foreground">{t('endOfList')}</p>
            )}
          </div>
        )}
      </div>

      <TransactionSheet
        tx={selected}
        onClose={() => setSelected(null)}
        onOpenOther={(id) => {
          void getTransactionAction(id).then((r) => {
            if (r.ok) setSelected(r.data);
            else report(r);
          });
        }}
        onOthersChanged={() => void reload()}
        accounts={accounts}
        categories={categories}
        groups={groups}
        recentIds={recentIds}
        canWrite={canWrite}
        onChange={update}
        onDeleted={(id) => setItems((cur) => cur.filter((i) => i.id !== id))}
      />
      {canWrite ? (
        <ManualTransactionSheet
          open={manualOpen}
          onOpenChange={closeManual}
          accounts={activeAccounts}
          groups={groups}
          today={today}
          defaultAccountId={lockAccountId ?? filters.accountIds[0]}
          onCreated={() => void reload()}
        />
      ) : null}
    </div>
  );
}
