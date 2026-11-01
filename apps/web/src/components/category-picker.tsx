'use client';

import { Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import type { CategoryDto, GroupDto } from '@/server/serialize';
import { AiBadge } from './ai-badge';
import { CategoryChip } from './category-icon';
import { confidenceBand } from '@/lib/ai-confidence';
import { ConfidenceLabel } from './confidence-label';

export interface PickOptions {
  /** Remember the choice for this merchant (on by default). */
  applyToMerchant: boolean;
  /** Also save a rule matching this merchant. */
  createRule: boolean;
}

export interface CategorySuggestion {
  categoryId: string;
  uses?: number;
  /** The AI's suggestion: its chip carries the "IA" badge and a confidence word. */
  ai?: { confidence: number | null };
}

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/**
 * The most used control in the app: suggestions first, then recent categories, then every group.
 * One tap applies the category and closes. The options above the list only matter for rows that
 * have a merchant (`ruleLabel` is set); a plain "pick a category" use hides them.
 */
export function CategoryPicker({
  open,
  onOpenChange,
  groups,
  selectedId,
  suggestions = [],
  recentIds = [],
  ruleLabel,
  showMerchantOptions = true,
  progress,
  amount,
  notice,
  onCloseAutoFocus,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: GroupDto[];
  selectedId?: string | null;
  suggestions?: CategorySuggestion[];
  recentIds?: string[];
  ruleLabel?: string | null;
  showMerchantOptions?: boolean;
  /** Review mode: "3 de 7". */
  progress?: string;
  /** Signed amount of the movement: spending groups list first for outflows, income for inflows. */
  amount?: number;
  /** Shown above the list (e.g. suggestions could not be loaded, with a retry). */
  notice?: ReactNode;
  onCloseAutoFocus?: (event: Event) => void;
  onPick: (categoryId: string, options: PickOptions) => void;
}) {
  const t = useTranslations('picker');
  const [query, setQuery] = useState('');
  const [applyToMerchant, setApplyToMerchant] = useState(true);
  const [createRule, setCreateRule] = useState(false);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setApplyToMerchant(true);
      setCreateRule(false);
    }
  }, [open]);

  // Transfers are linked, never picked; archived categories stay out of the way.
  const usable = useMemo(() => {
    const rank = (kind: GroupDto['kind']): number => {
      const order =
        amount !== undefined && amount > 0
          ? ['income', 'saving', 'expense']
          : ['expense', 'saving', 'income'];
      return order.indexOf(kind);
    };
    // Stable sort: groups keep their own order inside a kind.
    return groups
      .filter((g) => !g.archived && g.kind !== 'transfer')
      .map((g, index) => ({ g, index }))
      .sort((x, y) => rank(x.g.kind) - rank(y.g.kind) || x.index - y.index)
      .map(({ g }) => g);
  }, [groups, amount]);
  const byId = useMemo(
    () =>
      new Map(usable.flatMap((g) => g.categories.filter((c) => !c.archived).map((c) => [c.id, c]))),
    [usable],
  );
  const needle = fold(query.trim());
  const matches = (c: CategoryDto) => needle === '' || fold(c.name).includes(needle);

  const suggested = suggestions
    .map((s) => ({ category: byId.get(s.categoryId), ai: s.ai }))
    .filter((s): s is { category: CategoryDto; ai: CategorySuggestion['ai'] } => !!s.category);
  const recent = recentIds
    .map((id) => byId.get(id))
    .filter((c): c is CategoryDto => !!c)
    .filter((c) => !suggested.some((s) => s.category.id === c.id));

  const pick = (id: string) => onPick(id, { applyToMerchant, createRule });
  const visibleGroups = usable
    .map((g) => ({ group: g, categories: g.categories.filter((c) => !c.archived && matches(c)) }))
    .filter((g) => g.categories.length > 0);

  const chip = (c: CategoryDto, ai?: CategorySuggestion['ai']) => (
    <CategoryChip
      category={c}
      uncategorisedLabel={t('none')}
      large
      selected={c.id === selectedId}
      onClick={() => pick(c.id)}
      trailing={
        ai ? (
          <>
            {confidenceBand(ai.confidence) ? (
              <span className="inline-flex gap-1 text-sm font-normal text-muted-foreground">
                <span aria-hidden="true">·</span>
                <ConfidenceLabel confidence={ai.confidence} short />
              </span>
            ) : null}
            <AiBadge />
          </>
        ) : undefined
      }
      className="w-full justify-start text-sm md:text-base"
    />
  );

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('title')}
      description={progress}
      tall
      onOpenAutoFocus={(e) => {
        // Desktop: the search box is the first thing wanted. Phones: focusing it would raise the
        // keyboard and hide the list.
        if (window.matchMedia('(min-width: 768px)').matches && search.current) {
          e.preventDefault();
          search.current.focus();
        }
      }}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <div className="grid grid-cols-1 gap-5">
        {notice}
        {suggested.length > 0 && needle === '' ? (
          <section aria-labelledby="picker-suggested" className="grid grid-cols-1 gap-2">
            <h3 id="picker-suggested" className="text-sm font-medium text-muted-foreground">
              {t('suggested')}
            </h3>
            <ul className="flex flex-wrap gap-2">
              {suggested.map(({ category, ai }) => (
                <li key={category.id} className="max-w-full">
                  {chip(category, ai)}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {showMerchantOptions ? (
          <div className="grid grid-cols-1">
            <Checkbox
              label={
                ruleLabel
                  ? t('applyToMerchant', { merchant: ruleLabel })
                  : t('applyToMerchantGeneric')
              }
              checked={applyToMerchant}
              onChange={(e) => setApplyToMerchant(e.target.checked)}
            />
            {ruleLabel ? (
              <Checkbox
                label={t('createRule', { merchant: ruleLabel })}
                checked={createRule}
                onChange={(e) => setCreateRule(e.target.checked)}
              />
            ) : null}
          </div>
        ) : null}

        <div className="relative">
          <label htmlFor="picker-search" className="sr-only">
            {t('search')}
          </label>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="picker-search"
            ref={search}
            type="search"
            value={query}
            placeholder={t('search')}
            autoComplete="off"
            className="pl-10"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter picks the first match.
              if (e.key === 'Enter' && needle !== '' && visibleGroups[0]) {
                e.preventDefault();
                pick(visibleGroups[0].categories[0]!.id);
              }
            }}
          />
        </div>

        {recent.length > 0 && needle === '' ? (
          <section aria-labelledby="picker-recent" className="grid grid-cols-1 gap-2">
            <h3 id="picker-recent" className="text-sm font-medium text-muted-foreground">
              {t('recent')}
            </h3>
            <ul className="grid grid-cols-2 gap-2 md:grid-cols-1">
              {recent.map((c) => (
                <li key={c.id}>{chip(c)}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {visibleGroups.map(({ group, categories }) => (
          <section
            key={group.id}
            aria-labelledby={`picker-g-${group.id}`}
            className="grid grid-cols-1 gap-2"
          >
            <h3 id={`picker-g-${group.id}`} className="text-sm font-medium text-muted-foreground">
              {group.name}
            </h3>
            <ul className="grid grid-cols-2 gap-2 md:grid-cols-1">
              {categories.map((c) => (
                <li key={c.id}>{chip(c)}</li>
              ))}
            </ul>
          </section>
        ))}
        {needle !== '' && visibleGroups.length === 0 ? (
          <p className="text-base text-muted-foreground">{t('noMatch', { query: query.trim() })}</p>
        ) : null}
      </div>
    </Sheet>
  );
}
