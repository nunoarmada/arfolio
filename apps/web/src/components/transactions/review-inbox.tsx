'use client';

import { ArrowLeftRight, Check, CircleCheck, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { formatDate } from '@/lib/dates';
import {
  getTransactionAction,
  dismissTransferHintAction,
  getTxExtrasAction,
  loadReviewPageAction,
  markTransferAction,
  unlinkTransferAction,
} from '@/server/actions/transactions';
import type { AccountDto, CategoryDto, GroupDto, TxDto } from '@/server/serialize';
import type { ReviewPageDto, TransferHint, TxExtras } from '@/server/transactions-data';
import { AiBadge } from '../ai-badge';
import { CategoryChip } from '../category-icon';
import { ConfidenceLabel } from '../confidence-label';
import { CategoryPicker } from '../category-picker';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { Alert } from '../ui/alert';
import { Button, buttonVariants } from '../ui/button';
import { useToast } from '../ui/toast';
import { useFailureMessage, useReportFailure } from '../use-action-error';
import { moneyKindOf } from '@/lib/transaction-display';
import { TransactionSheet } from './transaction-sheet';
import { useCategorise } from './use-categorise';
import { useSentinel } from './use-sentinel';
import { useTxTitle } from './use-tx-title';

const COLLAPSE_MS = 180;

/** "A IA categorizou 14 movimentos nos últimos 30 dias. Ver e corrigir": they left the inbox. */
function AiAppliedLine({ count }: { count: number }) {
  const t = useTranslations('ai');
  if (count <= 0) return null;
  return (
    <span className="block text-sm text-muted-foreground">
      {t('appliedLine', { count })}{' '}
      <Link
        href="/transactions?by=ai&period=last-90"
        className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline"
      >
        {t('appliedLink')}
      </Link>
    </span>
  );
}
const HINT_KEY = 'pfm.review.intro.dismissed';

const byDateThenId = (a: TxDto, b: TxDto) =>
  a.purchaseDate === b.purchaseDate
    ? a.id < b.id
      ? -1
      : 1
    : a.purchaseDate < b.purchaseDate
      ? 1
      : -1;

type Tab = 'category' | 'transfers' | 'all';

export function ReviewInbox({
  initial,
  total,
  accounts,
  groups,
  categories,
  recentIds,
  canWrite,
  aiApplied,
}: {
  initial: ReviewPageDto;
  /** Rows waiting in the whole inbox (the first page may hold fewer). */
  total: number;
  accounts: AccountDto[];
  groups: GroupDto[];
  categories: CategoryDto[];
  recentIds: string[];
  canWrite: boolean;
  /** Movements the AI categorised in the last 30 days (they left the inbox but stay reversible). */
  aiApplied: number;
}) {
  const t = useTranslations('review');
  const titleOf = useTxTitle();
  const tx = useTranslations('transactions');
  const common = useTranslations('common');
  const toast = useToast();
  const report = useReportFailure();
  const failure = useFailureMessage();
  const { locale } = useHouseholdFormat();
  const categorise = useCategorise(categories);

  const [items, setItems] = useState<TxDto[]>(initial.items);
  const [hints, setHints] = useState<Record<string, TransferHint>>(initial.hints);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [handled, setHandled] = useState(0);
  // The inbox size when this page opened: progress reads "3 of 7" even though the layout's
  // count (and `total`) shrinks as rows are reviewed.
  const [initialTotal] = useState(total);
  const [tab, setTab] = useState<Tab>('all');
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [extras, setExtras] = useState<Record<string, TxExtras>>({});
  const [extrasFailed, setExtrasFailed] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<TxDto | null>(null);
  const [showIntro, setShowIntro] = useState(false);
  const timers = useRef(new Map<string, number>());
  const itemsRef = useRef<TxDto[]>(initial.items);
  // Rows collapsing right now: they no longer count as "left" (a transfer removes two at once).
  const leaving = useRef(new Set<string>());
  const listRef = useRef<HTMLUListElement>(null);

  itemsRef.current = items;
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const hasHint = (id: string) => hints[id] !== undefined && !dismissed.has(id);
  const transferCount = items.filter((i) => hasHint(i.id)).length;
  const visible = items.filter((i) =>
    tab === 'all' ? true : tab === 'transfers' ? hasHint(i.id) : !hasHint(i.id),
  );
  const remaining = Math.max(initialTotal - handled, items.length);

  useEffect(() => {
    try {
      setShowIntro(localStorage.getItem(HINT_KEY) !== '1');
    } catch {
      setShowIntro(true);
    }
  }, []);
  useEffect(() => {
    if (tab !== 'all' && transferCount === 0 && tab === 'transfers') setTab('all');
  }, [tab, transferCount]);

  const loadMore = useCallback(async () => {
    if (!cursor || loading) return;
    setLoading(true);
    setLoadError(null);
    const result = await loadReviewPageAction(cursor);
    setLoading(false);
    if (!result.ok) return setLoadError(failure(result));
    setItems((cur) => {
      const seen = new Set(cur.map((i) => i.id));
      return [...cur, ...result.data.items.filter((i) => !seen.has(i.id))];
    });
    setHints((cur) => ({ ...cur, ...result.data.hints }));
    setCursor(result.data.nextCursor);
  }, [cursor, failure, loading]);
  const sentinel = useSentinel<HTMLDivElement>(
    cursor !== null && !loading && !loadError,
    () => void loadMore(),
  );

  /** Moves focus to the next row's main button, or to the "all reviewed" heading when none is left. */
  const focusAfter = useCallback((nextId?: string) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const target = nextId
          ? listRef.current?.querySelector<HTMLElement>(`[data-primary="${nextId}"]`)
          : document.getElementById('review-done');
        target?.focus();
      }),
    );
  }, []);

  /** Collapses the row (180 ms), removes it and moves focus on; `restore` can still cancel it. */
  const remove = useCallback(
    (row: TxDto, nextId?: string) => {
      leaving.current.add(row.id);
      setRemoving((cur) => new Set(cur).add(row.id));
      window.clearTimeout(timers.current.get(row.id));
      timers.current.set(
        row.id,
        window.setTimeout(() => {
          timers.current.delete(row.id);
          setItems((cur) => cur.filter((i) => i.id !== row.id));
          setRemoving((cur) => {
            const next = new Set(cur);
            next.delete(row.id);
            return next;
          });
          setHandled((n) => n + 1);
          // Focus the next row; when nothing is left, the "all reviewed" heading. (When the picker is
          // open it moves on by itself and keeps focus.)
          leaving.current.delete(row.id);
          const left = itemsRef.current.filter(
            (i) => i.id !== row.id && !leaving.current.has(i.id),
          ).length;
          if (nextId) focusAfter(nextId);
          else if (left === 0) focusAfter();
        }, COLLAPSE_MS),
      );
    },
    [focusAfter],
  );

  const restore = useCallback((row: TxDto) => {
    leaving.current.delete(row.id);
    const timer = timers.current.get(row.id);
    const wasRemoved = timer === undefined;
    if (timer !== undefined) {
      // Still collapsing: cancel the removal, nothing was counted yet.
      window.clearTimeout(timer);
      timers.current.delete(row.id);
    }
    setRemoving((cur) => {
      const next = new Set(cur);
      next.delete(row.id);
      return next;
    });
    setItems((cur) => (cur.some((i) => i.id === row.id) ? cur : [...cur, row].sort(byDateThenId)));
    if (wasRemoved) setHandled((n) => Math.max(0, n - 1));
  }, []);

  /** Fetches the first page again (rows of the same merchant may have been categorised or restored). */
  const refresh = useCallback(async () => {
    const result = await loadReviewPageAction(null);
    if (!result.ok) return report(result);
    setItems(result.data.items);
    setHints(result.data.hints);
    setCursor(result.data.nextCursor);
  }, [report]);

  const nextAfter = (id: string): TxDto | undefined => {
    const i = visible.findIndex((v) => v.id === id);
    return (
      visible.slice(i + 1).find((v) => !removing.has(v.id)) ??
      visible
        .slice(0, i)
        .reverse()
        .find((v) => !removing.has(v.id))
    );
  };

  const mark = (id: string, on: boolean) =>
    setPending((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  function confirmSuggestion(row: TxDto) {
    // The suggestion is the rule's category, or the AI's when the row is still uncategorised.
    const suggestedId = row.categoryId ?? row.aiSuggestedCategoryId;
    if (!suggestedId || pending.has(row.id)) return;
    const next = nextAfter(row.id);
    void categorise(
      row,
      suggestedId,
      { applyToMerchant: true, createRule: false },
      {
        // The row leaves at once; a refusal puts it back.
        onOptimistic: () => {
          mark(row.id, true);
          remove(row, next?.id);
        },
        onRollback: () => {
          mark(row.id, false);
          restore(row);
        },
        onApplied: (_saved, also) => {
          mark(row.id, false);
          if (also > 0) void refresh();
        },
        onUndone: (restored, also) => {
          restore(restored);
          if (also > 0) void refresh();
        },
      },
    );
  }

  function loadExtras(row: TxDto) {
    setExtrasFailed((cur) => ({ ...cur, [row.id]: false }));
    void getTxExtrasAction(row.id).then((r) => {
      if (r.ok) setExtras((cur) => ({ ...cur, [row.id]: r.data }));
      else setExtrasFailed((cur) => ({ ...cur, [row.id]: true }));
    });
  }

  function openPicker(row: TxDto) {
    setPickingId(row.id);
    if (!extras[row.id]) loadExtras(row);
  }

  const picking = items.find((i) => i.id === pickingId) ?? null;

  function pick(categoryId: string, options: { applyToMerchant: boolean; createRule: boolean }) {
    if (!picking || pending.has(picking.id)) return;
    const row = picking;
    const next = nextAfter(row.id);
    void categorise(row, categoryId, options, {
      // Review mode: the sheet moves on to the next item at once instead of closing.
      onOptimistic: () => {
        mark(row.id, true);
        remove(row, undefined);
        if (next) openPicker(next);
        else setPickingId(null);
      },
      onRollback: () => {
        mark(row.id, false);
        restore(row);
        openPicker(row);
      },
      onApplied: (_saved, also) => {
        mark(row.id, false);
        if (also > 0) void refresh();
      },
      onUndone: (restored, also) => {
        restore(restored);
        if (also > 0) void refresh();
      },
    });
  }

  /** "Não é": saved on the server (both legs locked against pairing) so the hint never returns. */
  async function dismissHint(row: TxDto, partner: TxDto) {
    const result = await dismissTransferHintAction(row.id, partner.id);
    if (!result.ok) return report(result);
    setDismissed((cur) => new Set(cur).add(row.id).add(partner.id));
  }

  async function markTransfer(row: TxDto, partner: TxDto) {
    const result = await markTransferAction(row.id, partner.id);
    if (!result.ok) return report(result);
    const next = nextAfter(row.id);
    const partnerHere = items.find((i) => i.id === partner.id);
    remove(row, next?.id === partner.id ? undefined : next?.id);
    if (partnerHere) remove(partnerHere);
    toast.success(tx('transferMarked'), {
      label: tx('undo'),
      onClick: () => {
        void (async () => {
          const undone = await unlinkTransferAction(result.data.groupId);
          if (!undone.ok) return report(undone);
          for (const id of [row.id, partner.id]) {
            const fresh = await getTransactionAction(id);
            if (fresh.ok) restore(fresh.data);
          }
          toast.success(tx('undone'));
        })();
      },
    });
  }

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'all', label: t('tabAll') },
    { id: 'category', label: t('tabCategory') },
    { id: 'transfers', label: t('tabTransfers') },
  ];

  if (items.length === 0 && !cursor) {
    return (
      <EmptyState
        icon={<CircleCheck className="size-8 text-positive" />}
        title={t('doneTitle')}
        headingId="review-done"
      >
        {t('doneBody')}
        <Link href="/transactions" className={`${buttonVariants({ variant: 'outline' })} mt-3`}>
          {t('backToTransactions')}
        </Link>
        <AiAppliedLine count={aiApplied} />
      </EmptyState>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      {showIntro ? (
        <div className="flex items-start gap-2 rounded-lg bg-surface-2 p-3 text-sm text-muted-foreground">
          <p className="flex-1">{t('intro')}</p>
          <button
            type="button"
            aria-label={common('dismiss')}
            className="-m-2 flex size-11 shrink-0 items-center justify-center rounded-md hover:text-foreground"
            onClick={() => {
              setShowIntro(false);
              try {
                localStorage.setItem(HINT_KEY, '1');
              } catch {
                // Remembering the dismissal is a convenience only.
              }
            }}
          >
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {transferCount > 0 ? (
        <div
          role="group"
          aria-label={t('tabsLabel')}
          className="inline-flex w-fit rounded-lg bg-surface-2 p-1"
        >
          {tabs.map((tb) => (
            <button
              key={tb.id}
              type="button"
              aria-pressed={tab === tb.id}
              onClick={() => setTab(tb.id)}
              className={`min-h-11 rounded-md px-4 text-sm font-medium transition-colors duration-[120ms] md:min-h-9 ${
                tab === tb.id
                  ? 'bg-surface text-foreground shadow-[var(--shadow-sm)]'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {tb.label}
            </button>
          ))}
        </div>
      ) : null}

      <p className="sr-only" role="status">
        {t('remaining', { count: remaining })}
      </p>

      <ul ref={listRef} className="overflow-hidden rounded-lg bg-surface shadow-card">
        {visible.map((row) => {
          const hint = hints[row.id];
          const showHint = hasHint(row.id);
          const aiSuggestion = !row.categoryId ? row.aiSuggestedCategoryId : null;
          const hasSuggestion = row.categoryId !== null || aiSuggestion !== null;
          // Applied by the AI but not trusted: show how sure it was, or that it gave up.
          const aiApplied = row.categorisedBy === 'ai' && row.categoryId !== null;
          const gaveUp = aiApplied && row.aiConfidence === 0;
          const category = categoryById.get(row.categoryId ?? aiSuggestion ?? '');
          const account = accountById.get(row.accountId);
          const partner = showHint ? hint?.partner : null;
          const reason = showHint
            ? t('reasonTransfer')
            : gaveUp
              ? t('reasonGaveUp')
              : row.categoryId
                ? t('reasonLowConfidence')
                : aiSuggestion
                  ? t('reasonAi')
                  : t('reasonNone');
          const isRemoving = removing.has(row.id);
          return (
            <li
              key={row.id}
              className={`grid grid-cols-1 border-b last:border-b-0 transition-[grid-template-rows,opacity] duration-[180ms] ease-out ${
                isRemoving ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'
              }`}
            >
              <article className="min-h-0 overflow-hidden" aria-label={titleOf(row)}>
                <div className="grid grid-cols-1 gap-2 px-4 py-3 md:flex md:items-center md:gap-4">
                  <div className="flex items-start justify-between gap-3 md:contents">
                    <button
                      type="button"
                      onClick={() => setSelected(row)}
                      className="grid grid-cols-1 min-w-0 text-left md:order-1 md:min-w-48 md:flex-1"
                    >
                      <span className="truncate text-base font-medium">{titleOf(row)}</span>
                      <span className="truncate text-sm text-muted-foreground">
                        {formatDate(row.purchaseDate, locale)}
                        {account ? ` · ${account.name}` : ''}
                      </span>
                    </button>
                    <MoneyAmount
                      minor={row.amount}
                      currency={row.currency}
                      kind={moneyKindOf(row)}
                      pending={row.status === 'pending'}
                      className="md:order-3"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground md:order-2 md:min-w-0 md:flex-1">
                    <span>{reason}</span>
                    {aiSuggestion || aiApplied ? <AiBadge /> : null}
                    {category ? (
                      <CategoryChip category={category} uncategorisedLabel={tx('uncategorised')} />
                    ) : null}
                    {aiSuggestion || (aiApplied && !gaveUp) ? (
                      <ConfidenceLabel confidence={row.aiConfidence} />
                    ) : null}
                  </div>
                  {partner ? (
                    <div className="flex items-center justify-between gap-3 rounded-md bg-transfer-soft px-3 py-2 text-sm md:order-2 md:max-w-xs">
                      <span className="flex min-w-0 items-center gap-2">
                        <ArrowLeftRight
                          className="size-4 shrink-0 text-transfer"
                          aria-hidden="true"
                        />
                        <span className="truncate">
                          {titleOf(partner)}
                          {accountById.get(partner.accountId)
                            ? ` · ${accountById.get(partner.accountId)!.name}`
                            : ''}
                        </span>
                      </span>
                      <MoneyAmount
                        minor={partner.amount}
                        currency={partner.currency}
                        kind="transfer"
                        size="sm"
                        showSign
                      />
                    </div>
                  ) : null}
                  {canWrite ? (
                    <div className="flex flex-wrap justify-end gap-2 md:order-4 md:flex-nowrap">
                      {partner ? (
                        <>
                          <Button
                            variant="outline"
                            data-primary={row.id}
                            onClick={() => void dismissHint(row, partner)}
                          >
                            {t('notTransfer')}
                          </Button>
                          <Button
                            loading={pending.has(row.id)}
                            onClick={() => void markTransfer(row, partner)}
                          >
                            {t('isTransfer')}
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            variant={hasSuggestion ? 'outline' : 'default'}
                            data-primary={hasSuggestion ? undefined : row.id}
                            loading={pending.has(row.id)}
                            onClick={() => openPicker(row)}
                          >
                            {hasSuggestion ? t('change') : t('categorise')}
                          </Button>
                          {hasSuggestion ? (
                            <Button
                              data-primary={row.id}
                              loading={pending.has(row.id)}
                              onClick={() => confirmSuggestion(row)}
                            >
                              <Check className="size-5" aria-hidden="true" />
                              {t('confirm')}
                            </Button>
                          ) : null}
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              </article>
            </li>
          );
        })}
      </ul>

      <AiAppliedLine count={aiApplied} />

      {cursor ? (
        <div ref={sentinel} className="grid grid-cols-1 gap-3">
          {loadError ? <Alert tone="error">{loadError}</Alert> : null}
          <Button
            variant="outline"
            loading={loading}
            onClick={() => void loadMore()}
            className="justify-self-center"
          >
            {loadError ? common('retry') : tx('loadMore')}
          </Button>
        </div>
      ) : null}

      {canWrite ? (
        <CategoryPicker
          open={picking !== null}
          onOpenChange={(open) => !open && setPickingId(null)}
          groups={groups}
          selectedId={picking?.categoryId ?? null}
          suggestions={[
            // The suggestion that put the row here comes first: the rule's, else the AI's.
            ...(picking?.categoryId
              ? [{ categoryId: picking.categoryId }]
              : picking?.aiSuggestedCategoryId
                ? [
                    {
                      categoryId: picking.aiSuggestedCategoryId,
                      ai: { confidence: picking.aiConfidence },
                    },
                  ]
                : []),
            ...(picking ? (extras[picking.id]?.suggestions ?? []) : []).filter(
              (s) =>
                s.categoryId !== picking?.categoryId &&
                s.categoryId !== picking?.aiSuggestedCategoryId,
            ),
          ]}
          recentIds={recentIds}
          ruleLabel={picking ? (extras[picking.id]?.ruleLabel ?? null) : null}
          progress={
            picking
              ? `${t('progress', {
                  current: Math.min(handled + 1, Math.max(initialTotal, 1)),
                  total: Math.max(initialTotal, 1),
                })} · ${titleOf(picking)}`
              : undefined
          }
          amount={picking?.amount}
          notice={
            picking && extrasFailed[picking.id] ? (
              <Alert
                tone="warning"
                action={
                  <Button variant="outline" size="sm" onClick={() => loadExtras(picking)}>
                    {common('retry')}
                  </Button>
                }
              >
                {tx('extrasFailed')}
              </Alert>
            ) : undefined
          }
          onCloseAutoFocus={(e) => {
            // The row that opened the picker is usually gone: focus the next row, or the heading.
            e.preventDefault();
            const first = listRef.current?.querySelector<HTMLElement>('[data-primary]');
            if (first) first.focus();
            else document.getElementById('review-done')?.focus();
          }}
          onPick={pick}
        />
      ) : null}

      <TransactionSheet
        tx={selected}
        onClose={() => setSelected(null)}
        onOpenOther={(id) => {
          void getTransactionAction(id).then((r) => {
            if (r.ok) setSelected(r.data);
            else report(r);
          });
        }}
        onOthersChanged={() => void refresh()}
        accounts={accounts}
        categories={categories}
        groups={groups}
        recentIds={recentIds}
        canWrite={canWrite}
        onChange={(changed) => {
          setSelected((cur) => (cur?.id === changed.id ? changed : cur));
          // A row that left the review state (categorised in the sheet) leaves the inbox.
          if (!changed.needsReview) {
            setItems((cur) => cur.filter((i) => i.id !== changed.id));
            setHandled((n) => n + 1);
          } else if (items.some((i) => i.id === changed.id)) {
            setItems((cur) => cur.map((i) => (i.id === changed.id ? changed : i)));
          } else {
            restore(changed);
          }
        }}
        onDeleted={(id) => setItems((cur) => cur.filter((i) => i.id !== id))}
      />
    </div>
  );
}
