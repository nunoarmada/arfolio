'use client';

import { Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Monogram } from '@/components/account-badge';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import type { BankSummary } from '@arfolio/services';

const MAX_ROWS = 100;
const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/** Country, then a searchable list of that country's banks (monograms: no logos are loaded). */
export function BankPicker({
  country,
  countries,
  banks,
  loadFailed,
}: {
  country: string | null;
  countries: Array<{ code: string; name: string }>;
  banks: Pick<BankSummary, 'name' | 'beta'>[];
  loadFailed: boolean;
}) {
  const t = useTranslations('consent');
  const router = useRouter();
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);

  // Desktop: the search box is the first thing wanted. Phones: it would raise the keyboard.
  useEffect(() => {
    if (country && window.matchMedia('(min-width: 768px)').matches) search.current?.focus();
  }, [country]);

  const needle = fold(query.trim());
  const matches = banks.filter((b) => needle === '' || fold(b.name).includes(needle));
  const shown = matches.slice(0, MAX_ROWS);
  const countryName = countries.find((c) => c.code === country)?.name ?? country ?? '';

  const choose = (name: string) =>
    router.push(
      `/connections/new/bank/authorise?country=${encodeURIComponent(country ?? '')}&aspsp=${encodeURIComponent(name)}`,
    );

  return (
    <div className="grid grid-cols-1 max-w-[640px] gap-4">
      <Field label={t('country')}>
        {(p) => (
          <Select
            {...p}
            value={country ?? ''}
            onChange={(e) => {
              setQuery('');
              router.push(`/connections/new/bank?country=${e.target.value}`);
            }}
          >
            {country === null ? <option value="" /> : null}
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {country === null ? (
        <p className="text-base text-muted-foreground">{t('chooseCountry')}</p>
      ) : loadFailed ? (
        <ErrorState onRetry={() => router.refresh()} />
      ) : banks.length === 0 ? (
        <EmptyState title={t('noBanks', { country: countryName })} />
      ) : (
        <>
          <div className="relative">
            <label htmlFor="bank-search" className="sr-only">
              {t('search')}
            </label>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="bank-search"
              ref={search}
              type="search"
              value={query}
              placeholder={t('search')}
              autoComplete="off"
              className="pl-10"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <p role="status" className="text-sm text-muted-foreground">
            {t('count', { count: matches.length })}
          </p>
          {matches.length === 0 ? (
            <EmptyState title={t('noMatch', { query: query.trim() })}>
              <Button variant="outline" onClick={() => setQuery('')}>
                {t('clearSearch')}
              </Button>
            </EmptyState>
          ) : (
            <>
              <ul
                aria-label={t('banksList')}
                className="divide-y overflow-hidden rounded-lg bg-surface shadow-card"
              >
                {shown.map((b) => (
                  <li key={b.name}>
                    <button
                      type="button"
                      onClick={() => choose(b.name)}
                      className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left transition-colors duration-[120ms] hover:bg-surface-2"
                    >
                      <Monogram name={b.name} className="size-8 text-sm" />
                      <span className="min-w-0 flex-1 truncate text-base font-medium">
                        {b.name}
                      </span>
                      {b.beta ? (
                        <span className="shrink-0 rounded-[6px] border bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                          {t('beta')}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
              {matches.length > MAX_ROWS ? (
                <p className="text-sm text-muted-foreground">{t('refine')}</p>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
}
