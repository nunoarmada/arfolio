'use client';

import { Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { SaleCandidate } from '@arfolio/services';
import { formatDayYear } from '@/lib/net-worth-format';
import { searchSaleCandidatesAction } from '@/server/actions/net-worth';
import { EmptyState } from '../empty-state';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Input } from '../ui/field';
import { Skeleton } from '../ui/skeleton';

const PAGE = 8;
const DEBOUNCE_MS = 250;

type Status = 'loading' | 'ready' | 'error';

/**
 * The transactions that could have received an asset's sale: the 8 newest, 8 more on request,
 * searched on the server (debounced). Everything resets when `active` turns true again.
 */
export function useSaleCandidates(assetId: string, active: boolean) {
  const [query, setQuery] = useState('');
  const [term, setTerm] = useState('');
  const termRef = useRef('');
  const [limit, setLimit] = useState(PAGE);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    status: Status;
    rows: SaleCandidate[];
    more: boolean;
    forTerm: string | null;
  }>({ status: 'loading', rows: [], more: false, forTerm: null });
  /** What the unfiltered first page held: decides the sheet's starting mode. */
  const [initial, setInitial] = useState<'pending' | 'empty' | 'some' | 'error'>('pending');

  useEffect(() => {
    if (!active) return;
    setQuery('');
    setTerm('');
    termRef.current = '';
    setLimit(PAGE);
    setResult({ status: 'loading', rows: [], more: false, forTerm: null });
    setInitial('pending');
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      const next = query.trim();
      if (next === termRef.current) return;
      termRef.current = next;
      setTerm(next);
      setLimit(PAGE);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, active]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setResult((r) => ({ ...r, status: 'loading' }));
    void searchSaleCandidatesAction(assetId, term, limit + 1).then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        setResult({ status: 'error', rows: [], more: false, forTerm: term });
        if (term === '') setInitial((i) => (i === 'pending' ? 'error' : i));
        return;
      }
      setResult({
        status: 'ready',
        rows: res.data.slice(0, limit),
        more: res.data.length > limit,
        forTerm: term,
      });
      if (term === '')
        setInitial((i) => (i === 'pending' ? (res.data.length ? 'some' : 'empty') : i));
    });
    return () => {
      cancelled = true;
    };
  }, [assetId, active, term, limit, attempt]);

  return {
    query,
    setQuery,
    term,
    result,
    initial,
    /** A search in flight with nothing to show yet (first load, or the term changed). */
    busy: result.status === 'loading' && result.forTerm !== term,
    showMore: () => setLimit((l) => l + PAGE),
    retry: () => setAttempt((a) => a + 1),
    shown: result.rows.length,
  };
}

export type SaleCandidates = ReturnType<typeof useSaleCandidates>;

/** Search, count and a radio list of candidate transactions (native radios: arrows move, Space picks). */
export function SaleTransactionPicker({
  candidates,
  selectedId,
  onSelect,
  currency,
  error,
  searchRef,
  onEnterByHand,
}: {
  candidates: SaleCandidates;
  selectedId: string | null;
  onSelect: (candidate: SaleCandidate) => void;
  currency: string;
  /** The service's or the sheet's complaint about the choice. */
  error: string | null;
  searchRef: RefObject<HTMLInputElement | null>;
  onEnterByHand: () => void;
}) {
  const t = useTranslations('disposal');
  const { locale } = useHouseholdFormat();
  const { query, setQuery, term, result, initial, busy } = candidates;
  const listRef = useRef<HTMLDivElement>(null);
  const focusAt = useRef<number | null>(null);
  const noneAtAll = initial === 'empty' && term === '';
  const failed = result.status === 'error';

  // "Mostrar mais" leaves focus on the first row it added.
  useEffect(() => {
    if (focusAt.current === null || result.status !== 'ready') return;
    const radios = listRef.current?.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    radios?.[focusAt.current]?.focus();
    focusAt.current = null;
  }, [result]);

  // Desktop: the search is the first thing wanted. On phones it would raise the keyboard.
  useEffect(() => {
    if (window.matchMedia('(min-width: 768px)').matches) searchRef.current?.focus();
  }, [searchRef]);

  return (
    <div className="grid gap-3">
      {noneAtAll || (failed && initial === 'error') ? null : (
        <div className="relative">
          <label htmlFor="sale-search" className="sr-only">
            {t('searchLabel')}
          </label>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="sale-search"
            ref={searchRef}
            type="search"
            value={query}
            placeholder={t('searchPlaceholder')}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'sale-picker-error' : undefined}
            className="pl-10"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      {/* One live region for the whole picker; only its text changes. */}
      <p role="status" className="text-sm text-muted-foreground empty:hidden">
        {failed || noneAtAll
          ? ''
          : busy
            ? t('loading')
            : result.rows.length === 0
              ? t('noMatch', { query: term })
              : t('count', { count: result.rows.length })}
      </p>

      {failed ? (
        <Alert
          tone="error"
          action={
            <Button variant="outline" onClick={candidates.retry}>
              {t('retry')}
            </Button>
          }
        >
          {t('loadFailed')}
        </Alert>
      ) : busy ? (
        <div aria-busy="true" className="grid gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
        </div>
      ) : noneAtAll ? (
        <EmptyState
          title={t('emptyTitle')}
          action={
            <Button variant="outline" onClick={onEnterByHand}>
              {t('modeHand')}
            </Button>
          }
        >
          {t('emptyBody', { currency })}
        </EmptyState>
      ) : result.rows.length === 0 ? (
        <div className="grid justify-items-start gap-2">
          <Button variant="outline" onClick={() => setQuery('')}>
            {t('clearSearch')}
          </Button>
        </div>
      ) : (
        <>
          <div
            ref={listRef}
            role="radiogroup"
            aria-label={t('listLabel')}
            className="divide-y divide-border overflow-hidden rounded-lg bg-surface shadow-card"
          >
            {result.rows.map((c) => (
              <label
                key={c.id}
                className="group flex min-h-14 cursor-pointer items-center gap-3 px-4 py-2 transition-colors duration-[120ms] hover:bg-surface-2 has-[:checked]:bg-primary-soft"
              >
                <input
                  type="radio"
                  name="sale-transaction"
                  checked={selectedId === c.id}
                  onChange={() => onSelect(c)}
                  className="size-5 shrink-0 accent-[var(--primary)]"
                />
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-base font-medium" title={c.description}>
                    {c.description}
                  </span>
                  <span className="truncate text-sm text-muted-foreground">
                    {formatDayYear(c.bookingDate, locale)} · {c.accountName}
                  </span>
                </span>
                <MoneyAmount
                  minor={c.amount}
                  currency={c.currency}
                  kind="income"
                  // the income green is below 4.5:1 on the selection tint
                  className="shrink-0 group-has-[:checked]:text-foreground"
                />
              </label>
            ))}
          </div>
          {result.more ? (
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => {
                focusAt.current = result.rows.length;
                candidates.showMore();
              }}
            >
              {t('showMore')}
            </Button>
          ) : null}
        </>
      )}
      {error ? (
        <p id="sale-picker-error" role="alert" className="text-sm text-negative">
          {error}
        </p>
      ) : null}
    </div>
  );
}
