'use client';

import { ChevronDown, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { truncateName } from '@/lib/budget-import-copy';
import { cn } from '@/lib/cn';
import type { CategoryDto, GroupDto } from '@/server/serialize';
import { CategoryIcon } from '../category-icon';
import { Button } from '../ui/button';
import { Input } from '../ui/field';
import { Sheet } from '../ui/sheet';

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/**
 * Picks the categories a budget line counts. A category can belong to one line per budget, so
 * those already used by another line stay visible but cannot be ticked, and say where they are.
 */
export function CategoryMultiPicker({
  open,
  onOpenChange,
  groups,
  kind,
  selected,
  takenBy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: GroupDto[];
  kind: 'income' | 'expense' | 'saving';
  selected: readonly string[];
  /** Category id -> name of the other line of this budget that already counts it. */
  takenBy: ReadonlyMap<string, string>;
  onConfirm: (ids: string[]) => void;
}) {
  const t = useTranslations('budgetLine.picker');
  const common = useTranslations('common');
  const [draft, setDraft] = useState<Set<string>>(new Set(selected));
  const [query, setQuery] = useState('');
  const [others, setOthers] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(new Set(selected));
    setQuery('');
    setOthers(false);
    setBlocked(null);
  }, [open, selected]);

  const usable = useMemo(
    () => groups.filter((g) => !g.archived && g.kind !== 'transfer'),
    [groups],
  );
  const needle = fold(query.trim());
  const visible = (g: GroupDto): CategoryDto[] =>
    g.categories.filter((c) => !c.archived && (needle === '' || fold(c.name).includes(needle)));
  const matching = usable.filter((g) => g.kind === kind);
  const rest = usable.filter((g) => g.kind !== kind);
  // While searching, "other categories" open by themselves so nothing hides a match.
  const showOthers = others || needle !== '';

  function toggle(c: CategoryDto) {
    const owner = takenBy.get(c.id);
    if (owner) {
      setBlocked(t('moveHint', { line: truncateName(owner) }));
      return;
    }
    setBlocked(null);
    setDraft((cur) => {
      const next = new Set(cur);
      if (next.has(c.id)) next.delete(c.id);
      else next.add(c.id);
      return next;
    });
  }

  const row = (c: CategoryDto) => {
    const owner = takenBy.get(c.id);
    const checked = draft.has(c.id);
    const describedBy = owner ? `taken-${c.id}` : undefined;
    return (
      <li key={c.id}>
        <label
          className={cn(
            'flex min-h-12 items-center gap-3 rounded-lg border border-transparent px-2 py-1 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring',
            owner
              ? 'cursor-not-allowed text-muted-foreground'
              : 'cursor-pointer hover:bg-surface-2',
            checked && 'border-primary bg-primary-soft',
          )}
        >
          <input
            type="checkbox"
            checked={checked}
            aria-disabled={owner ? true : undefined}
            aria-describedby={describedBy}
            onChange={() => toggle(c)}
            onClick={(e) => {
              // A category another line counts cannot be ticked: say why instead.
              if (owner) {
                e.preventDefault();
                toggle(c);
              }
            }}
            className="size-5 shrink-0 accent-[var(--primary)]"
          />
          <CategoryIcon category={c} size={28} />
          <span className="grid grid-cols-1 min-w-0 flex-1">
            <span className="break-words text-base">{c.name}</span>
            {owner ? (
              <span id={describedBy} className="text-sm text-muted-foreground">
                {t('alreadyIn', { line: truncateName(owner) })}
              </span>
            ) : null}
          </span>
        </label>
      </li>
    );
  };

  const section = (g: GroupDto) => {
    const categories = visible(g);
    if (categories.length === 0) return null;
    return (
      <section key={g.id} aria-labelledby={`pick-g-${g.id}`} className="grid grid-cols-1 gap-1">
        <h3 id={`pick-g-${g.id}`} className="text-sm font-medium text-muted-foreground">
          {g.name}
        </h3>
        <ul className="grid grid-cols-1 gap-0.5">{categories.map(row)}</ul>
      </section>
    );
  };

  const anyMatch = [...matching, ...rest].some((g) => visible(g).length > 0);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('title')}
      tall
      onOpenAutoFocus={(e) => {
        if (window.matchMedia('(min-width: 768px)').matches && search.current) {
          e.preventDefault();
          search.current.focus();
        }
      }}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {common('cancel')}
          </Button>
          <Button
            onClick={() => {
              onConfirm([...draft]);
              onOpenChange(false);
            }}
          >
            {t('confirm', { count: draft.size })}
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <p className="text-sm text-muted-foreground">{t('rule')}</p>
        <div className="relative">
          <label htmlFor="budget-picker-search" className="sr-only">
            {t('search')}
          </label>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="budget-picker-search"
            ref={search}
            type="search"
            value={query}
            placeholder={t('search')}
            autoComplete="off"
            className="pl-10"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <p role="status" className="min-h-5 text-sm font-medium text-warning">
          {blocked}
        </p>
        {matching.map(section)}
        {rest.some((g) => visible(g).length > 0) ? (
          <div className="grid grid-cols-1 gap-3">
            <button
              type="button"
              aria-expanded={showOthers}
              onClick={() => setOthers((v) => !v)}
              className="flex min-h-11 items-center gap-2 text-left text-base font-medium text-primary"
            >
              <ChevronDown
                className={cn(
                  'size-4 transition-transform duration-[180ms]',
                  !showOthers && '-rotate-90',
                )}
                aria-hidden="true"
              />
              {t('others')}
            </button>
            {showOthers ? rest.map(section) : null}
          </div>
        ) : null}
        {needle !== '' && !anyMatch ? (
          <p className="text-base text-muted-foreground">{t('noMatch', { query: query.trim() })}</p>
        ) : null}
      </div>
    </Sheet>
  );
}
