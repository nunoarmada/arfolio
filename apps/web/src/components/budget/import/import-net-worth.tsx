'use client';

import { ChevronDown, ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { BudgetImportPreview } from '@arfolio/services';
import { defaultSelection } from '@/lib/budget-import-links';
import { truncateName } from '@/lib/budget-import-copy';
import { cn } from '@/lib/cn';
import { addMonths, formatMonthShort } from '@/lib/dates';
import { useHouseholdFormat } from '../../household-format';
import { Checkbox } from '../../ui/checkbox';
import { Select } from '../../ui/select';
import { MatchChip } from './match-chip';
import { useFormatMoney } from '@/components/privacy';

export type NetWorthPreview = NonNullable<BudgetImportPreview['patrimonio']>;
export type GoalsPreview = NonNullable<BudgetImportPreview['goals']>;
type PreviewRow = NetWorthPreview['assets'][number] | NetWorthPreview['liabilities'][number];
export type SheetRow = PreviewRow;

/** The sheet's assets then its liabilities. */
export function sheetRows(preview: NetWorthPreview): SheetRow[] {
  return [...preview.assets, ...preview.liabilities];
}

// ---------------------------------------------------------------------------------------------
// Review: the Património and Objetivos tabs

/** Ativos and Passivos of the sheet: what each is, how many values it has, and what it matches. */
export function NetWorthReview({
  preview,
  startMonth,
  accountNames,
}: {
  preview: NetWorthPreview;
  startMonth: string;
  /** Household account id -> name. */
  accountNames: ReadonlyMap<string, string>;
}) {
  const t = useTranslations('budgetImport.review');
  const baseId = useId();
  return (
    <>
      {(
        [
          ['asset', preview.assets, t('assets'), t('noAssets')],
          ['liability', preview.liabilities, t('liabilities'), t('noLiabilities')],
        ] as const
      ).map(([side, rows, heading, empty]) => (
        <section
          key={side}
          aria-labelledby={`${baseId}-${side}`}
          className="grid grid-cols-1 gap-2"
        >
          <h3 id={`${baseId}-${side}`} className="text-base font-semibold">
            {heading}
          </h3>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{empty}</p>
          ) : (
            <ul className="divide-y overflow-hidden rounded-md bg-surface-2">
              {rows.map((row) => (
                <NetWorthRow
                  key={row.linkKey}
                  row={row}
                  startMonth={startMonth}
                  accountNames={accountNames}
                />
              ))}
            </ul>
          )}
        </section>
      ))}
    </>
  );
}

function NetWorthRow({
  row,
  startMonth,
  accountNames,
}: {
  row: SheetRow;
  startMonth: string;
  accountNames: ReadonlyMap<string, string>;
}) {
  const t = useTranslations('budgetImport.review');
  const kinds = useTranslations('netWorth.kind');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const money = (minor: number) => formatMoney(minor, currency, locale);
  const [open, setOpen] = useState(false);
  const latest = row.values.reduce<(typeof row.values)[number] | null>(
    (best, v) => (best === null || v.asOf > best.asOf ? v : best),
    null,
  );
  const byMonth = new Map(row.values.map((v) => [v.asOf.slice(0, 7), v.amount]));
  const months = Array.from({ length: 12 }, (_, i) => addMonths(startMonth, i));
  const suggested = row.suggestedAccountId ? accountNames.get(row.suggestedAccountId) : undefined;

  return (
    <li className="grid grid-cols-1 gap-1 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-[10rem] flex-1">
          <p className="line-clamp-2 break-words text-base font-medium" title={row.name}>
            {truncateName(row.name, 60)}
          </p>
          <p className="text-sm text-muted-foreground">{kinds(row.kind)}</p>
        </div>
        <MatchChip
          matchLabel={
            row.suggestedAccountId
              ? t('matchesAccount', { name: truncateName(suggested ?? row.name, 30) })
              : null
          }
          newLabel={t('isNewRow')}
        />
      </div>
      <p className="text-sm tabular-nums text-muted-foreground">
        {latest
          ? t('monthsFilled', {
              count: row.values.length,
              month: formatMonthShort(latest.asOf, locale),
              amount: money(latest.amount),
            })
          : t('noValues')}
        {row.match ? ` · ${t('updatesExisting')}` : ''}
      </p>
      {row.values.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex min-h-11 items-center gap-1 text-sm text-primary"
          >
            <ChevronDown
              className={cn('size-4 transition-transform duration-[180ms]', !open && '-rotate-90')}
              aria-hidden="true"
            />
            {t('showValues')}
            <span className="sr-only"> {truncateName(row.name, 60)}</span>
          </button>
          {open ? (
            <dl className="grid grid-cols-3 gap-x-4 gap-y-2 pb-1 pt-1 md:grid-cols-4">
              {months.map((month) => {
                const amount = byMonth.get(month.slice(0, 7));
                return (
                  <div key={month} className="grid grid-cols-1">
                    <dt className="text-xs text-muted-foreground">
                      {formatMonthShort(month, locale)}
                    </dt>
                    <dd className="text-sm tabular-nums">
                      {amount === undefined ? '—' : money(amount)}
                    </dd>
                  </div>
                );
              })}
            </dl>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

/** The sheet's goals: target, contribution and whether a saving line of the same name exists. */
export function GoalsReview({ goals }: { goals: GoalsPreview }) {
  const t = useTranslations('budgetImport.review');
  const goalText = useTranslations('goals');
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const money = (minor: number) => formatMoney(minor, currency, locale);
  if (goals.length === 0) return <p className="text-sm text-muted-foreground">{t('noGoals')}</p>;
  return (
    <ul className="divide-y overflow-hidden rounded-md bg-surface-2">
      {goals.map((goal) => (
        <li key={goal.name} className="grid grid-cols-1 gap-0.5 px-4 py-3">
          <p className="line-clamp-2 break-words text-base font-medium" title={goal.name}>
            {truncateName(goal.name, 60)}
          </p>
          {goal.kind === 'emergency_fund' ? (
            <span className="inline-flex w-fit items-center gap-1 rounded-sm bg-surface-2 px-2 py-0.5 text-sm font-medium">
              <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
              {goalText('emergencyTag')}
            </span>
          ) : null}
          <p className="text-sm text-muted-foreground">
            {t('goalMeta', {
              target:
                goal.kind === 'emergency_fund'
                  ? t('targetDerived')
                  : goal.target === null
                    ? t('goalNoTarget')
                    : t('goalTarget', { amount: money(goal.target) }),
              contribution:
                goal.contribution === null
                  ? goalText('noContribution')
                  : goalText('perMonth', { amount: money(goal.contribution) }),
              line: goal.lineMatch
                ? t('goalLine', { name: truncateName(goal.name, 40) })
                : t('goalNoLine'),
            })}
          </p>
          {goal.match ? (
            <p className="text-sm text-muted-foreground">{t('updatesExisting')}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Options: include checkboxes and the account links

export interface AccountChoice {
  id: string;
  name: string;
}

/** The accounts each side can link (see linkableFor), and the record that counts each one now. */
export interface LinkChoices {
  asset: AccountChoice[];
  liability: AccountChoice[];
  /** Account id -> id of the live asset or liability linked to it. */
  claimedBy: Record<string, string>;
}

const fieldsetClass = 'grid grid-cols-1 gap-1 rounded-md bg-surface-2 px-4 py-2';
const legendClass = 'px-1 text-base font-semibold';

/** "Património": include it, and for each row which account (if any) supplies its value. */
export function NetWorthOptions({
  preview,
  include,
  onInclude,
  selection,
  onSelect,
  accounts,
  accountNames,
  disabled,
}: {
  preview: NetWorthPreview;
  include: boolean;
  onInclude: (value: boolean) => void;
  /** Row key -> chosen account id ('' for none); a row not listed keeps its default. */
  selection: Readonly<Record<string, string>>;
  onSelect: (key: string, accountId: string) => void;
  /** Accounts a row can be linked to. */
  accounts: LinkChoices;
  /** Every account's name, archived ones included (a record can still be linked to one). */
  accountNames: ReadonlyMap<string, string>;
  disabled: boolean;
}) {
  const t = useTranslations('budgetImport.options');
  const rows = sheetRows(preview);
  const assetKeys = new Set(preview.assets.map((r) => r.linkKey));
  // A row may take an account of its side that no other record counts (its own match may).
  const choicesFor = (row: SheetRow) =>
    accounts[assetKeys.has(row.linkKey) ? 'asset' : 'liability'].filter(
      (a) => (accounts.claimedBy[a.id] ?? row.match) === row.match,
    );
  const suggested = rows.filter((r) => r.suggestedAccountId !== null);
  const others = rows.filter((r) => r.suggestedAccountId === null);
  const renderRow = (row: SheetRow) => (
    <LinkChoice
      key={row.linkKey}
      row={row}
      value={selection[row.linkKey] ?? defaultSelection(row)}
      onChange={(id) => onSelect(row.linkKey, id)}
      accounts={choicesFor(row)}
      accountNames={accountNames}
      disabled={disabled}
    />
  );
  return (
    <fieldset className={fieldsetClass}>
      <legend className={legendClass}>{t('netWorthLegend')}</legend>
      <Checkbox
        label={t('includeNetWorth', {
          assets: preview.assets.length,
          liabilities: preview.liabilities.length,
        })}
        hint={include ? undefined : t('netWorthOff')}
        checked={include}
        disabled={disabled}
        onChange={(e) => onInclude(e.target.checked)}
      />
      {include ? (
        <div className="grid grid-cols-1 gap-3 border-t py-3">
          <div className="grid grid-cols-1 gap-1">
            <h3 className="text-base font-semibold">{t('linkTitle')}</h3>
            <p className="max-w-[68ch] text-sm text-muted-foreground">{t('linkHelp')}</p>
          </div>
          {suggested.length > 0 ? (
            <div className="grid grid-cols-1 gap-3">{suggested.map(renderRow)}</div>
          ) : null}
          {others.length > 0 ? (
            <details className="group grid grid-cols-1 gap-3">
              <summary className="flex min-h-11 w-fit cursor-pointer items-center gap-1 text-sm text-primary">
                <ChevronDown
                  className="size-4 -rotate-90 transition-transform duration-[180ms] group-open:rotate-0"
                  aria-hidden="true"
                />
                {t('otherRows', { count: others.length })}
              </summary>
              <div className="grid grid-cols-1 gap-3 pl-5 pt-2">{others.map(renderRow)}</div>
            </details>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}

function LinkChoice({
  row,
  value,
  onChange,
  accounts,
  accountNames,
  disabled,
}: {
  row: SheetRow;
  value: string;
  onChange: (accountId: string) => void;
  accounts: AccountChoice[];
  accountNames: ReadonlyMap<string, string>;
  disabled: boolean;
}) {
  const t = useTranslations('budgetImport.options');
  const kinds = useTranslations('netWorth.kind');
  const id = useId();
  // The account a record is linked to now stays choosable even if it was archived since.
  const extra =
    row.currentAccountId && !accounts.some((a) => a.id === row.currentAccountId)
      ? [{ id: row.currentAccountId, name: accountNames.get(row.currentAccountId) ?? row.name }]
      : [];
  return (
    <div className="grid grid-cols-1 gap-1.5">
      <div className="grid grid-cols-1 gap-0.5">
        <label htmlFor={id} className="break-words text-sm font-medium">
          {t('linkLabel', { name: truncateName(row.name, 60) })}
        </label>
        <span id={`${id}-kind`} className="text-sm text-muted-foreground">
          {kinds(row.kind)}
        </span>
        {row.match ? (
          <span id={`${id}-keeps`} className="text-sm text-muted-foreground">
            {t('keepsLink')}
          </span>
        ) : null}
      </div>
      <Select
        id={id}
        value={value}
        disabled={disabled}
        aria-describedby={row.match ? `${id}-kind ${id}-keeps` : `${id}-kind`}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t('linkNone')}</option>
        {[...accounts, ...extra].map((a) => (
          <option key={a.id} value={a.id}>
            {truncateName(a.name, 60)}
          </option>
        ))}
      </Select>
    </div>
  );
}

/** "Objetivos": include them or not. */
export function GoalsOptions({
  count,
  include,
  onInclude,
  disabled,
}: {
  count: number;
  include: boolean;
  onInclude: (value: boolean) => void;
  disabled: boolean;
}) {
  const t = useTranslations('budgetImport.options');
  return (
    <fieldset className={fieldsetClass}>
      <legend className={legendClass}>{t('goalsLegend')}</legend>
      <Checkbox
        label={t('includeGoals', { count })}
        hint={include ? t('goalsHint') : t('goalsOff')}
        checked={include}
        disabled={disabled}
        onChange={(e) => onInclude(e.target.checked)}
      />
    </fieldset>
  );
}
