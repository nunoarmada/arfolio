'use client';

import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import type { BudgetImportPreview } from '@arfolio/services';
import { monthlyAverage } from '@/lib/budget-grid';
import { describeWarning, sectionKey, truncateName } from '@/lib/budget-import-copy';
import { addMonths, formatMonth, formatMonthShort } from '@/lib/dates';
import { cn } from '@/lib/cn';
import { useHouseholdFormat } from '../../household-format';
import { MoneyAmount } from '../../money-amount';
import { Alert } from '../../ui/alert';
import { GoalsReview, NetWorthReview } from './import-net-worth';
import { MatchChip } from './match-chip';
import { useFormatMoney } from '@/components/privacy';

type Tab = 'lines' | 'accounts' | 'subscriptions' | 'netWorth' | 'goals';
const KINDS = ['income', 'expense', 'saving'] as const;

/** Section names as the import reports them, said in the interface language. */
export function useSectionLabel(): (value: string | number | undefined) => string {
  const t = useTranslations('budgetImport.sections');
  return (value) => {
    const key = sectionKey(value);
    return key ? t(key) : truncateName(value, 30);
  };
}

/** What the sheet contains and what would happen to it: counters, warnings and three lists. */
export function ImportReview({
  preview,
  accountNames,
  groupNames,
}: {
  preview: BudgetImportPreview;
  /** Household account id -> name, to say what a sheet account matches. */
  accountNames: ReadonlyMap<string, string>;
  groupNames: ReadonlyMap<string, string>;
}) {
  const t = useTranslations('budgetImport.review');
  const kinds = useTranslations('budget.kinds');
  const cadences = useTranslations('recurring.cadence');
  const warnings = useTranslations('budgetImport');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const money = (minor: number) => formatMoney(minor, currency, locale);
  const section = useSectionLabel();
  const [tab, setTab] = useState<Tab>('lines');
  const [openLine, setOpenLine] = useState<string | null>(null);
  const baseId = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const list = useRef<HTMLDivElement>(null);
  // More tabs to the right than fit: fade the edge until the end of the list is reached.
  const [fade, setFade] = useState(false);
  const measure = () => {
    const el = list.current;
    if (el) setFade(el.scrollWidth - el.scrollLeft - el.clientWidth > 4);
  };

  // The selected tab is always in view, whether it was clicked or reached with the keyboard.
  useEffect(() => {
    tabs.current[order.indexOf(tab)]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    measure();
  }, [tab]);

  const newAccounts = preview.accounts.filter((a) => a.match === null).length;
  const newGroups = preview.groups.filter((g) => g.match === null).length;
  // Património and Objetivos get a tab only when the file has the sheet.
  const order: Tab[] = [
    'lines',
    'accounts',
    'subscriptions',
    ...(preview.patrimonio ? (['netWorth'] as const) : []),
    ...(preview.goals ? (['goals'] as const) : []),
  ];
  const counts: Record<Tab, number> = {
    lines: preview.lines.length,
    accounts: preview.accounts.length + preview.groups.length,
    subscriptions: preview.subscriptions.length,
    netWorth:
      (preview.patrimonio?.assets.length ?? 0) + (preview.patrimonio?.liabilities.length ?? 0),
    goals: preview.goals?.length ?? 0,
  };

  const months = Array.from({ length: 12 }, (_, i) =>
    formatMonthShort(addMonths(preview.startMonth, i), locale),
  );
  const end = addMonths(preview.startMonth, 11);

  function onKey(e: React.KeyboardEvent, index: number) {
    const move = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const target = e.key === 'Home' ? 0 : order.length - 1;
      setTab(order[target]!);
      tabs.current[target]?.focus();
      return;
    }
    if (!move) return;
    e.preventDefault();
    const target = (index + move + order.length) % order.length;
    setTab(order[target]!);
    tabs.current[target]?.focus();
  }

  const warningItems = preview.warnings.map((w) => describeWarning(w, money, section));

  return (
    <div className="grid grid-cols-1 gap-5">
      <div className="grid grid-cols-1 gap-1">
        <p className="text-lg font-semibold">
          {t('summary', {
            name: truncateName(preview.budgetName, 60),
            from: formatMonth(preview.startMonth, locale),
            to: formatMonth(end, locale),
          })}
        </p>
        <p className="text-sm tabular-nums text-muted-foreground" data-testid="import-counters">
          {t('counters', {
            lines: preview.lines.length,
            accounts: preview.accounts.length,
            newAccounts,
            groups: preview.groups.length,
            newGroups,
            subscriptions: preview.subscriptions.length,
          })}
          {preview.subscriptionsSkipped > 0
            ? ` · ${t('inactiveSkipped', { count: preview.subscriptionsSkipped })}`
            : ''}
          {preview.patrimonio || preview.goals
            ? ` · ${t('nwCounters', {
                assets: preview.patrimonio?.assets.length ?? 0,
                liabilities: preview.patrimonio?.liabilities.length ?? 0,
                goals: preview.goals?.length ?? 0,
              })}`
            : ''}
        </p>
      </div>

      {preview.existingBudgetId ? <Alert tone="warning">{t('existing')}</Alert> : null}

      {warningItems.length > 0 ? (
        <Alert tone="warning" title={t('warnings', { count: warningItems.length })}>
          <ul className="grid grid-cols-1 list-disc gap-1 pl-4">
            {warningItems.map((w, i) => (
              <li key={i}>{warnings(w.key, w.values)}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-3">
        <div
          ref={list}
          role="tablist"
          aria-label={t('tabsLabel')}
          onScroll={measure}
          className={cn(
            'inline-flex w-fit max-w-full scroll-px-1 overflow-x-auto whitespace-nowrap rounded-lg bg-surface-2 p-1',
            fade &&
              'max-md:[mask-image:linear-gradient(to_right,#000_calc(100%-24px),transparent)]',
          )}
        >
          {order.map((id, i) => (
            <button
              key={id}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`${baseId}-panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => setTab(id)}
              onKeyDown={(e) => onKey(e, i)}
              className={cn(
                'min-h-11 rounded-md px-3 text-sm font-medium transition-colors duration-[120ms] md:min-h-9',
                tab === id
                  ? 'bg-surface text-foreground shadow-[var(--shadow-sm)]'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`tab.${id}`, { count: counts[id] })}
            </button>
          ))}
        </div>

        <div
          role="tabpanel"
          id={`${baseId}-panel-lines`}
          aria-labelledby={`${baseId}-tab-lines`}
          hidden={tab !== 'lines'}
          tabIndex={0}
          className="grid grid-cols-1 gap-5 outline-offset-4"
        >
          {KINDS.map((kind) => {
            const lines = preview.lines.filter((l) => l.kind === kind);
            if (lines.length === 0) return null;
            return (
              <section
                key={kind}
                aria-labelledby={`${baseId}-kind-${kind}`}
                className="grid grid-cols-1 gap-2"
              >
                <h3 id={`${baseId}-kind-${kind}`} className="text-base font-semibold">
                  {kinds(`${kind}Plural`)}
                </h3>
                <div className="overflow-hidden rounded-lg bg-surface shadow-card">
                  <div
                    aria-hidden="true"
                    className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_112px_112px] gap-x-3 border-b px-4 py-2 text-xs font-medium text-muted-foreground md:grid"
                  >
                    <span>{t('line')}</span>
                    <span>{t('group')}</span>
                    <span>{t('account')}</span>
                    <span className="text-right">{t('total')}</span>
                    <span className="text-right">{t('average')}</span>
                  </div>
                  <ul className="divide-y">
                    {lines.map((line) => {
                      const key = `${kind}:${line.name}`;
                      const total = line.amounts.reduce((a, b) => a + b, 0);
                      const expanded = openLine === key;
                      return (
                        <li key={key} className="px-4 py-3">
                          <div className="grid grid-cols-1 gap-x-3 gap-y-1 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_112px_112px] md:items-center">
                            <p className="min-w-0 truncate text-base font-medium" title={line.name}>
                              {truncateName(line.name, 60)}
                            </p>
                            <p className="min-w-0 truncate text-sm text-muted-foreground md:hidden">
                              {[line.group, line.account]
                                .filter((v): v is string => Boolean(v))
                                .map((v) => truncateName(v, 30))
                                .join(' · ') || t('noGroupAccount')}
                            </p>
                            <p className="hidden min-w-0 truncate text-sm text-muted-foreground md:block">
                              {line.group ? truncateName(line.group, 30) : '—'}
                            </p>
                            <p className="hidden min-w-0 truncate text-sm text-muted-foreground md:block">
                              {line.account ? truncateName(line.account, 30) : '—'}
                            </p>
                            <p className="text-sm tabular-nums text-muted-foreground md:hidden">
                              {t('totalAndAverage', {
                                total: money(total),
                                average: money(monthlyAverage(total, 12)),
                              })}
                            </p>
                            <p className="hidden text-right text-sm tabular-nums md:block">
                              {money(total)}
                            </p>
                            <p className="hidden text-right text-sm tabular-nums md:block">
                              {money(monthlyAverage(total, 12))}
                            </p>
                          </div>
                          <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() => setOpenLine(expanded ? null : key)}
                            className="mt-1 flex min-h-11 items-center gap-1 text-sm text-primary"
                          >
                            <ChevronDown
                              className={cn(
                                'size-4 transition-transform duration-[180ms]',
                                !expanded && '-rotate-90',
                              )}
                              aria-hidden="true"
                            />
                            {t('showMonths')}
                            <span className="sr-only"> {truncateName(line.name, 60)}</span>
                          </button>
                          {expanded ? (
                            <dl className="grid grid-cols-3 gap-x-4 gap-y-2 pb-1 pt-1 md:grid-cols-4">
                              {line.amounts.map((amount, i) => (
                                <div key={i} className="grid grid-cols-1">
                                  <dt className="text-xs text-muted-foreground">{months[i]}</dt>
                                  <dd className="text-sm tabular-nums">{money(amount)}</dd>
                                </div>
                              ))}
                            </dl>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </section>
            );
          })}
        </div>

        <div
          role="tabpanel"
          id={`${baseId}-panel-accounts`}
          aria-labelledby={`${baseId}-tab-accounts`}
          hidden={tab !== 'accounts'}
          tabIndex={0}
          className="grid grid-cols-1 gap-5 outline-offset-4"
        >
          <section aria-labelledby={`${baseId}-accounts`} className="grid grid-cols-1 gap-2">
            <h3 id={`${baseId}-accounts`} className="text-base font-semibold">
              {t('accounts')}
            </h3>
            {preview.accounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noAccounts')}</p>
            ) : (
              <ul className="divide-y overflow-hidden rounded-lg bg-surface shadow-card">
                {preview.accounts.map((a) => (
                  <MatchRow
                    key={a.name}
                    name={a.name}
                    match={a.match ? (accountNames.get(a.match) ?? a.name) : null}
                  />
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby={`${baseId}-groups`} className="grid grid-cols-1 gap-2">
            <h3 id={`${baseId}-groups`} className="text-base font-semibold">
              {t('groups')}
            </h3>
            {preview.groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noGroups')}</p>
            ) : (
              <ul className="divide-y overflow-hidden rounded-lg bg-surface shadow-card">
                {preview.groups.map((g) => (
                  <MatchRow
                    key={`${g.kind}:${g.name}`}
                    name={g.name}
                    detail={kinds(`${g.kind}Plural`)}
                    match={g.match ? (groupNames.get(g.match) ?? g.name) : null}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>

        <div
          role="tabpanel"
          id={`${baseId}-panel-subscriptions`}
          aria-labelledby={`${baseId}-tab-subscriptions`}
          hidden={tab !== 'subscriptions'}
          tabIndex={0}
          className="grid grid-cols-1 gap-3 outline-offset-4"
        >
          {preview.subscriptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noSubscriptions')}</p>
          ) : (
            <ul className="divide-y overflow-hidden rounded-lg bg-surface shadow-card">
              {preview.subscriptions.map((s) => (
                <li key={`${s.name}:${s.cadence}`} className="grid grid-cols-1 gap-0.5 px-4 py-3">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-base font-medium" title={s.name}>
                      {truncateName(s.name, 60)}
                    </span>
                    <MoneyAmount minor={s.amount} currency={currency} kind="expense" />
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {cadences(s.cadence)}
                    {s.account ? ` · ${truncateName(s.account, 30)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm text-muted-foreground">{t('renewalNote')}</p>
        </div>

        {preview.patrimonio ? (
          <div
            role="tabpanel"
            id={`${baseId}-panel-netWorth`}
            aria-labelledby={`${baseId}-tab-netWorth`}
            hidden={tab !== 'netWorth'}
            tabIndex={0}
            className="grid grid-cols-1 gap-5 outline-offset-4"
          >
            <NetWorthReview
              preview={preview.patrimonio}
              startMonth={preview.startMonth}
              accountNames={accountNames}
            />
          </div>
        ) : null}

        {preview.goals ? (
          <div
            role="tabpanel"
            id={`${baseId}-panel-goals`}
            aria-labelledby={`${baseId}-tab-goals`}
            hidden={tab !== 'goals'}
            tabIndex={0}
            className="grid grid-cols-1 gap-3 outline-offset-4"
          >
            <GoalsReview goals={preview.goals} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MatchRow({
  name,
  detail,
  match,
}: {
  name: string;
  detail?: string;
  match: string | null;
}) {
  const t = useTranslations('budgetImport.review');
  return (
    <li className="flex min-h-14 items-center gap-3 px-4 py-2">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base" title={name}>
          {truncateName(name, 60)}
        </span>
        {detail ? <span className="block text-sm text-muted-foreground">{detail}</span> : null}
      </span>
      <MatchChip
        matchLabel={match !== null ? t('matches', { name: truncateName(match, 30) }) : null}
        newLabel={t('isNew')}
      />
    </li>
  );
}
