'use client';

import { ChevronDown, Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, Input } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useScrollEdges } from '@/components/ui/scroll-region';
import { cn } from '@/lib/cn';
import {
  activeFilterCount,
  DEFAULT_PERIOD,
  emptyFilters,
  PERIODS,
  type Period,
  type TxFilters,
} from '@/lib/transaction-filters';
import type { AccountDto, GroupDto } from '@/server/serialize';

const SEARCH_DEBOUNCE_MS = 250;

function Chip({
  label,
  active,
  onOpen,
  onClear,
  clearLabel,
  pressed,
  expanded,
}: {
  label: string;
  active: boolean;
  onOpen: () => void;
  onClear?: () => void;
  clearLabel?: string;
  /** For toggle chips. */
  pressed?: boolean;
  expanded?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-10 shrink-0 items-center rounded-full text-sm font-medium transition-colors duration-[120ms] md:h-9',
        active
          ? 'bg-primary-soft-strong text-primary-text shadow-[inset_0_0_0_1px_var(--primary-border)]'
          : 'bg-surface text-foreground shadow-[inset_0_0_0_1px_var(--border-strong)]',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-pressed={pressed}
        aria-haspopup={expanded === undefined ? undefined : 'dialog'}
        className={cn(
          'flex h-full items-center gap-1.5 whitespace-nowrap rounded-full pl-3.5 outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring',
          active && onClear ? 'pr-1' : 'pr-3.5',
        )}
      >
        {label}
        {expanded !== undefined ? (
          <ChevronDown className="size-4 opacity-60" aria-hidden="true" />
        ) : null}
      </button>
      {active && onClear ? (
        <button
          type="button"
          onClick={onClear}
          aria-label={clearLabel}
          className="flex h-full w-10 items-center justify-center rounded-full text-primary-text outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring md:w-9"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

/**
 * Search plus a scrollable row of filter chips. Each chip opens a sheet with its options and
 * applies them together (one navigation per change, not one per click).
 */
export function FilterBar({
  filters,
  onChange,
  accounts,
  groups,
  lockAccount = false,
  defaultPeriod = DEFAULT_PERIOD,
  showAiFilter = false,
}: {
  filters: TxFilters;
  onChange: (next: TxFilters) => void;
  accounts: AccountDto[];
  groups: GroupDto[];
  lockAccount?: boolean;
  defaultPeriod?: Period;
  /** The household uses AI categorisation or already has AI-categorised rows. */
  showAiFilter?: boolean;
}) {
  const t = useTranslations('filters');
  const ai = useTranslations('ai');
  const [sheet, setSheet] = useState<null | 'period' | 'account' | 'category' | 'type'>(null);
  const [text, setText] = useState(filters.q);
  const searchRef = useRef<HTMLInputElement>(null);
  const latest = useRef(filters);
  latest.current = filters;

  // Debounce typing into the URL. `applied` remembers what this box last sent, so a URL change
  // that came from elsewhere (e.g. "Limpar pesquisa") is copied back into the box.
  const applied = useRef(filters.q);
  useEffect(() => {
    if (text.trim() === latest.current.q) return;
    const id = window.setTimeout(() => {
      applied.current = text.trim();
      onChange({ ...latest.current, q: text.trim() });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [text, onChange]);
  useEffect(() => {
    if (filters.q !== applied.current) {
      applied.current = filters.q;
      setText(filters.q);
    }
  }, [filters.q]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName)))
        return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? '';
  const categoryName = (id: string) =>
    groups.flatMap((g) => g.categories).find((c) => c.id === id)?.name ?? '';
  const many = (ids: string[], name: (id: string) => string) =>
    ids.length === 1 ? name(ids[0]!) : String(ids.length);

  const periodLabel =
    filters.period === 'custom' ? t('period.custom') : t(`period.${filters.period}`);
  const active = activeFilterCount(filters, defaultPeriod);
  const edges = useScrollEdges();

  return (
    <div className="grid grid-cols-1 gap-3 lg:flex lg:items-start lg:gap-3">
      <div className="relative min-w-0 md:max-w-[420px] lg:w-72 lg:shrink-0 xl:w-80">
        <label htmlFor="tx-search" className="sr-only">
          {t('search')}
        </label>
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id="tx-search"
          ref={searchRef}
          type="search"
          value={text}
          placeholder={t('search')}
          autoComplete="off"
          className="pl-10"
          onChange={(e) => setText(e.target.value)}
        />
      </div>

      {/* Below md the chips scroll sideways; a fade on the side with more says so. */}
      <div
        data-start={edges.start}
        data-end={edges.end}
        className="relative -mx-4 min-w-0 md:mx-0 lg:flex-1 max-md:before:pointer-events-none max-md:before:absolute max-md:before:inset-y-0 max-md:before:left-0 max-md:before:z-10 max-md:before:w-8 max-md:before:bg-gradient-to-r max-md:before:from-background max-md:before:to-transparent max-md:before:opacity-0 max-md:before:transition-opacity max-md:after:pointer-events-none max-md:after:absolute max-md:after:inset-y-0 max-md:after:right-0 max-md:after:z-10 max-md:after:w-8 max-md:after:bg-gradient-to-l max-md:after:from-background max-md:after:to-transparent max-md:after:opacity-0 max-md:after:transition-opacity max-md:data-[start=false]:before:opacity-100 max-md:data-[end=false]:after:opacity-100"
      >
        <div
          ref={edges.ref}
          role="group"
          aria-label={t('groupLabel')}
          className="flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:flex-wrap md:overflow-visible md:px-0 md:pb-0 [&::-webkit-scrollbar]:hidden"
        >
          <Chip
            label={`${t('periodLabel')}: ${periodLabel}`}
            active={filters.period !== defaultPeriod}
            expanded={false}
            onOpen={() => setSheet('period')}
            onClear={() =>
              onChange({ ...filters, period: defaultPeriod, from: undefined, to: undefined })
            }
            clearLabel={t('clearOne', { filter: t('periodLabel') })}
          />
          {filters.booked ? (
            <Chip
              label={t('onlyBooked')}
              active
              pressed
              onOpen={() => onChange({ ...filters, booked: undefined })}
            />
          ) : null}
          {filters.excludeTransfers ? (
            <Chip
              label={t('noTransfers')}
              active
              pressed
              onOpen={() => onChange({ ...filters, excludeTransfers: undefined })}
            />
          ) : null}
          {filters.transfersOnly ? (
            <Chip
              label={t('onlyTransfers')}
              active
              pressed
              onOpen={() => onChange({ ...filters, transfersOnly: undefined })}
            />
          ) : null}
          {lockAccount ? null : (
            <Chip
              label={
                filters.accountIds.length
                  ? `${t('accountLabel')}: ${many(filters.accountIds, accountName)}`
                  : t('accountLabel')
              }
              active={filters.accountIds.length > 0}
              expanded={false}
              onOpen={() => setSheet('account')}
              onClear={() => onChange({ ...filters, accountIds: [] })}
              clearLabel={t('clearOne', { filter: t('accountLabel') })}
            />
          )}
          <Chip
            label={
              filters.categoryIds.length
                ? `${t('categoryLabel')}: ${many(filters.categoryIds, categoryName)}`
                : t('categoryLabel')
            }
            active={filters.categoryIds.length > 0}
            expanded={false}
            onOpen={() => setSheet('category')}
            onClear={() => onChange({ ...filters, categoryIds: [] })}
            clearLabel={t('clearOne', { filter: t('categoryLabel') })}
          />
          <Chip
            label={
              filters.direction
                ? `${t('typeLabel')}: ${t(filters.direction === 'out' ? 'typeOut' : 'typeIn')}`
                : t('typeLabel')
            }
            active={filters.direction !== undefined}
            expanded={false}
            onOpen={() => setSheet('type')}
            onClear={() => onChange({ ...filters, direction: undefined })}
            clearLabel={t('clearOne', { filter: t('typeLabel') })}
          />
          <Chip
            label={t('pending')}
            active={filters.pending}
            pressed={filters.pending}
            // Pending and booked-only exclude each other: picking one drops the other.
            onOpen={() => onChange({ ...filters, pending: !filters.pending, booked: undefined })}
          />
          <Chip
            label={t('needsReview')}
            active={filters.review}
            pressed={filters.review}
            onOpen={() => onChange({ ...filters, review: !filters.review })}
          />
          {showAiFilter || filters.by === 'ai' ? (
            <Chip
              label={filters.by === 'ai' ? ai('filterActive') : ai('filter')}
              active={filters.by === 'ai'}
              pressed={filters.by === 'ai'}
              onOpen={() => onChange({ ...filters, by: filters.by === 'ai' ? undefined : 'ai' })}
            />
          ) : null}
          {active >= 2 ? (
            <Chip
              label={t('clearAll')}
              active={false}
              onOpen={() => {
                setText('');
                onChange({
                  ...emptyFilters(defaultPeriod),
                  accountIds: lockAccount ? filters.accountIds : [],
                });
              }}
            />
          ) : null}
        </div>
      </div>

      <TypeSheet
        open={sheet === 'type'}
        onClose={() => setSheet(null)}
        value={filters.direction}
        onApply={(direction) => onChange({ ...filters, direction })}
      />
      <PeriodSheet
        open={sheet === 'period'}
        onClose={() => setSheet(null)}
        filters={filters}
        onApply={onChange}
      />
      <MultiSheet
        open={sheet === 'account'}
        onClose={() => setSheet(null)}
        title={t('accountLabel')}
        selected={filters.accountIds}
        sections={[
          {
            id: 'accounts',
            label: null,
            options: accounts.map((a) => ({
              id: a.id,
              label: a.archived ? `${a.name} (${t('archived')})` : a.name,
            })),
          },
        ]}
        onApply={(ids) => onChange({ ...filters, accountIds: ids })}
      />
      <MultiSheet
        open={sheet === 'category'}
        onClose={() => setSheet(null)}
        title={t('categoryLabel')}
        selected={filters.categoryIds}
        sections={groups.map((g) => ({
          id: g.id,
          label: g.name,
          options: g.categories.map((c) => ({ id: c.id, label: c.name })),
        }))}
        onApply={(ids) => onChange({ ...filters, categoryIds: ids })}
      />
    </div>
  );
}

function PeriodSheet({
  open,
  onClose,
  filters,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  filters: TxFilters;
  onApply: (next: TxFilters) => void;
}) {
  const t = useTranslations('filters');
  const common = useTranslations('common');
  const [period, setPeriod] = useState<Period>(filters.period);
  const [from, setFrom] = useState(filters.from ?? '');
  const [to, setTo] = useState(filters.to ?? '');
  useEffect(() => {
    if (open) {
      setPeriod(filters.period);
      setFrom(filters.from ?? '');
      setTo(filters.to ?? '');
    }
  }, [open, filters.period, filters.from, filters.to]);
  const customInvalid = period === 'custom' && !from && !to;

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t('periodLabel')}
      footer={
        <Button
          className="w-full"
          disabled={customInvalid}
          onClick={() => {
            onApply({
              ...filters,
              period,
              from: period === 'custom' && from ? from : undefined,
              to: period === 'custom' && to ? to : undefined,
            });
            onClose();
          }}
        >
          {common('apply')}
        </Button>
      }
    >
      <fieldset className="grid grid-cols-1 gap-1">
        <legend className="sr-only">{t('periodLabel')}</legend>
        {PERIODS.map((p) => (
          <label key={p} className="flex min-h-11 cursor-pointer items-center gap-3">
            <input
              type="radio"
              name="period"
              value={p}
              checked={period === p}
              onChange={() => setPeriod(p)}
              className="size-5 accent-[var(--primary)]"
            />
            <span className="text-base">{t(`period.${p}`)}</span>
          </label>
        ))}
      </fieldset>
      {period === 'custom' ? (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Field label={t('from')}>
            {(p) => (
              <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            )}
          </Field>
          <Field label={t('to')}>
            {(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}
          </Field>
        </div>
      ) : null}
    </Sheet>
  );
}

function MultiSheet({
  open,
  onClose,
  title,
  selected,
  sections,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  selected: string[];
  sections: Array<{
    id: string;
    label: string | null;
    options: Array<{ id: string; label: string }>;
  }>;
  onApply: (ids: string[]) => void;
}) {
  const common = useTranslations('common');
  const [draft, setDraft] = useState<string[]>(selected);
  useEffect(() => {
    if (open) setDraft(selected);
  }, [open, selected]);
  const toggle = (id: string) =>
    setDraft((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      tall
      footer={
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setDraft([])}>
            {common('clear')}
          </Button>
          <Button
            className="flex-1"
            onClick={() => {
              onApply(draft);
              onClose();
            }}
          >
            {common('apply')}
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        {sections.map((s) => (
          <fieldset key={s.id} className="grid grid-cols-1">
            {s.label ? (
              <legend className="mb-1 text-sm font-medium text-muted-foreground">{s.label}</legend>
            ) : null}
            {s.options.map((o) => (
              <Checkbox
                key={o.id}
                label={o.label}
                checked={draft.includes(o.id)}
                onChange={() => toggle(o.id)}
              />
            ))}
          </fieldset>
        ))}
      </div>
    </Sheet>
  );
}

function TypeSheet({
  open,
  onClose,
  value,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  value: 'in' | 'out' | undefined;
  onApply: (next: 'in' | 'out' | undefined) => void;
}) {
  const t = useTranslations('filters');
  const common = useTranslations('common');
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => {
    if (open) setDraft(value ?? '');
  }, [open, value]);
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t('typeLabel')}
      footer={
        <Button
          className="w-full"
          onClick={() => {
            onApply(draft === 'in' || draft === 'out' ? draft : undefined);
            onClose();
          }}
        >
          {common('apply')}
        </Button>
      }
    >
      <fieldset className="grid grid-cols-1 gap-1">
        <legend className="sr-only">{t('typeLabel')}</legend>
        {(
          [
            ['', t('typeAll')],
            ['out', t('typeOut')],
            ['in', t('typeIn')],
          ] as const
        ).map(([v, label]) => (
          <label key={v} className="flex min-h-11 cursor-pointer items-center gap-3">
            <input
              type="radio"
              name="type"
              value={v}
              checked={draft === v}
              onChange={() => setDraft(v)}
              className="size-5 accent-[var(--primary)]"
            />
            <span className="text-base">{label}</span>
          </label>
        ))}
      </fieldset>
    </Sheet>
  );
}
