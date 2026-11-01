'use client';

import {
  AlertTriangle,
  CalendarClock,
  Info,
  MoreHorizontal,
  Pencil,
  Plus,
  Repeat,
  X,
} from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from 'react';
import { truncateName } from '@/lib/budget-import-copy';
import { formatDate } from '@/lib/dates';
import { cn } from '@/lib/cn';
import {
  isOverdue,
  partitionRecurring,
  perMonth,
  type RecurringDto,
} from '@/lib/recurring-display';
import {
  confirmRecurringAction,
  dismissRecurringAction,
  reopenRecurringAction,
} from '@/server/actions/recurring';
import type { GroupDto } from '@/server/serialize';
import { AccountBadge } from '../account-badge';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { KpiGrid } from '../home/kpi-tiles';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { KpiTile } from '../ui/kpi-tile';
import { SectionHeader } from '../ui/section-header';
import { useToast } from '../ui/toast';
import { useFailureMessage } from '../use-action-error';
import { EmptyState } from '../empty-state';
import { PageHeader } from '../page-header';
import { RecurringSheet } from './recurring-sheet';
import { PageContainer } from '@/components/page-container';
import { useFormatMoney } from '@/components/privacy';

type AccountLite = { id: string; name: string; type: string; archived: boolean };

const MENU_ITEM =
  'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-3 text-base outline-none data-[highlighted]:bg-surface-2 lg:pointer-fine:min-h-9 lg:pointer-fine:text-sm';

/**
 * Detected payments to confirm, the confirmed and declared ones with what they cost per month, and
 * a way to add what detection cannot find (for example a subscription at a shop you also use a lot).
 */
export function SubscriptionsView({
  title,
  nav,
  items: initialItems,
  monthlyCost,
  accounts,
  groups,
  lines,
  today,
  canWrite,
  initialEditId,
}: {
  title: string;
  /** The budget sub-navigation, rendered under the title. */
  nav: ReactNode;
  items: RecurringDto[];
  monthlyCost: { currency: string; amount: number };
  accounts: AccountLite[];
  groups: GroupDto[];
  lines: Array<{ id: string; name: string }>;
  today: string;
  canWrite: boolean;
  initialEditId: string | null;
}) {
  const t = useTranslations('recurring');
  const cadences = useTranslations('recurring.cadence');
  const sources = useTranslations('recurring.source');
  const columns = useTranslations('recurring.columns');
  const toast = useToast();
  const router = useRouter();
  const failure = useFailureMessage();
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const money = (minor: number) => formatMoney(minor, currency, locale);
  const [items, setItems] = useState(initialItems);
  const [leaving, setLeaving] = useState<string | null>(null);
  const [editing, setEditing] = useState<RecurringDto | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [, startTransition] = useTransition();
  const confirmedHeading = useRef<HTMLHeadingElement>(null);
  const lastOpened = useRef<string | null>(null);

  useEffect(() => setItems(initialItems), [initialItems]);

  const { detected, established } = useMemo(() => partitionRecurring(items), [items]);

  // The detection that was just decided, until the list has actually dropped it. Focus moves
  // when that is true of a render (not after a fixed delay, and not at the first render that
  // follows: the list also renders with the old rows while a slow device catches up).
  const decidedId = useRef<string | null>(null);
  useEffect(() => {
    const id = decidedId.current;
    if (!id || detected.some((d) => d.id === id)) return;
    decidedId.current = null;
    // Focus goes to the next detection, else to the confirmed list.
    const next = detected[0];
    if (next) document.getElementById(`confirm-${next.id}`)?.focus();
    else confirmedHeading.current?.focus();
  }, [detected]);
  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  // ?edit=<id> and #rec-<id> (from a notification) point at one item.
  useEffect(() => {
    if (initialEditId) {
      const target = initialItems.find((i) => i.id === initialEditId);
      if (target && canWrite) {
        setEditing(target);
        setSheetOpen(true);
      }
    }
    const id = window.location.hash.match(/^#rec-([0-9a-f-]{36})$/i)?.[1];
    if (id) {
      const el = document.getElementById(`rec-${id}`);
      el?.scrollIntoView({ block: 'center' });
      el?.querySelector<HTMLElement>('button, a')?.focus({ preventScroll: true });
    }
    // Only on arrival.
  }, []);

  function replace(row: RecurringDto) {
    setItems((cur) =>
      cur.some((i) => i.id === row.id)
        ? cur.map((i) => (i.id === row.id ? row : i))
        : [...cur, row],
    );
  }

  function decide(item: RecurringDto, kind: 'confirm' | 'dismiss') {
    setLeaving(item.id);
    startTransition(async () => {
      const result =
        kind === 'confirm'
          ? await confirmRecurringAction(item.id)
          : await dismissRecurringAction(item.id);
      if (!result.ok) {
        setLeaving(null);
        return toast.error(failure(result));
      }
      // Let the card fold away before the list changes under the reader's eyes.
      window.setTimeout(() => {
        decidedId.current = item.id;
        replace(result.data);
        setLeaving(null);
        router.refresh();
      }, 180);
      toast.success(
        t(kind === 'confirm' ? 'confirmed' : 'dismissed', { name: truncateName(item.name) }),
        {
          label: t('undo'),
          onClick: () =>
            void reopenRecurringAction(item.id).then((undone) => {
              if (!undone.ok) return toast.error(failure(undone));
              replace(undone.data);
              router.refresh();
            }),
        },
      );
    });
  }

  function openItem(item: RecurringDto | null, focusId?: string) {
    lastOpened.current = focusId ?? (item ? `rec-${item.id}` : null);
    setEditing(item);
    setSheetOpen(true);
  }

  const addButton = canWrite ? (
    <Button onClick={() => openItem(null)}>
      <Plus className="size-5" aria-hidden="true" />
      {t('add')}
    </Button>
  ) : null;
  const header = (
    <PageHeader
      title={title}
      tabs={nav}
      actions={
        canWrite ? (
          <Button
            variant="outline"
            aria-label={t('add')}
            title={t('add')}
            className="max-md:w-11 max-md:px-0"
            onClick={() => openItem(null)}
          >
            <Plus className="size-4" aria-hidden="true" />
            <span className="max-md:sr-only">{t('add')}</span>
          </Button>
        ) : undefined
      }
    />
  );

  const sheet = canWrite ? (
    <RecurringSheet
      open={sheetOpen}
      onOpenChange={(open) => {
        setSheetOpen(open);
        if (!open && lastOpened.current) {
          const el = document.getElementById(lastOpened.current);
          // A row id holds the row's first control; a control id (the "⋯" button) is focused itself.
          const target = el?.matches('button, a')
            ? el
            : el?.querySelector<HTMLElement>('button, a');
          window.setTimeout(() => target?.focus(), 50);
        }
      }}
      item={editing}
      accounts={accounts}
      groups={groups}
      lines={lines}
      onSaved={(row) => {
        replace(row);
        router.refresh();
      }}
      onDismissed={(row) => {
        replace(row);
        router.refresh();
      }}
    />
  ) : null;

  if (items.length === 0) {
    return (
      <PageContainer>
        {header}
        <div className="grid grid-cols-1 gap-6">
          <EmptyState icon={<Repeat />} title={t('emptyTitle')} action={addButton ?? undefined}>
            {t('emptyBody')}
          </EmptyState>
          {sheet}
        </div>
      </PageContainer>
    );
  }

  const cadenceLabel = (i: RecurringDto) => cadences(i.cadence);
  // The soonest payment still ahead among the confirmed ones: the second tile of the strip.
  const upcoming = established
    .filter((i) => i.nextExpectedOn !== null && i.nextExpectedOn >= today)
    .sort((a, b) => a.nextExpectedOn!.localeCompare(b.nextExpectedOn!))[0];

  // One column template for the header row and every row, from lg (below it each row is a card).
  const CONFIRM_COLUMNS =
    'lg:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_5rem_7rem_6rem_10.5rem] lg:gap-x-4';
  const FIXED_COLUMNS =
    'lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.4fr)_minmax(6rem,1fr)_minmax(8rem,1.3fr)_6.5rem] lg:gap-x-4';
  const headCell = 'truncate';

  return (
    <PageContainer>
      {header}
      <div className="grid grid-cols-1 gap-6">
        <section aria-label={t('monthlyCost')}>
          <KpiGrid label={t('monthlyCost')}>
            <KpiTile
              label={t('monthlyCost')}
              icon={Repeat}
              value={
                <MoneyAmount
                  minor={monthlyCost.amount}
                  currency={monthlyCost.currency}
                  kind="expense"
                  showSign={false}
                  size="kpi"
                />
              }
              comparison={t('perMonthShort')}
            />
            {upcoming ? (
              <KpiTile
                label={t('nextPayment')}
                icon={CalendarClock}
                value={
                  <MoneyAmount
                    minor={upcoming.amount}
                    currency={upcoming.currency}
                    kind={upcoming.amount > 0 ? 'income' : 'expense'}
                    showSign={false}
                    size="kpi"
                  />
                }
                comparison={
                  <>
                    <span className="whitespace-nowrap">
                      {formatDate(upcoming.nextExpectedOn!, locale)}
                    </span>{' '}
                    <span>{truncateName(upcoming.name, 24)}</span>
                  </>
                }
              />
            ) : null}
          </KpiGrid>
        </section>

        {detected.length > 0 ? (
          <section aria-labelledby="to-confirm" className="grid grid-cols-1 gap-2">
            <SectionHeader id="to-confirm" title={t('toConfirm', { count: detected.length })} />
            <p className="text-sm text-muted-foreground">{t('toConfirmHelp')}</p>
            <div className="grid grid-cols-1 gap-3 lg:gap-0 lg:overflow-hidden lg:rounded-lg lg:bg-surface lg:shadow-card">
              <div
                aria-hidden="true"
                className={cn(
                  'hidden h-10 items-center border-b border-border bg-surface-2 px-4 text-label font-medium text-muted-foreground lg:grid',
                  CONFIRM_COLUMNS,
                )}
              >
                <span className={headCell}>{columns('name')}</span>
                <span className={headCell}>{columns('account')}</span>
                <span className={headCell}>{columns('cadence')}</span>
                <span className={headCell}>{columns('next')}</span>
                <span className={cn(headCell, 'text-right')}>{columns('amount')}</span>
                <span />
              </div>
              <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-1 lg:gap-0 lg:divide-y lg:divide-border">
                {detected.map((item) => {
                  const account = item.accountId ? accountById.get(item.accountId) : undefined;
                  const kind = item.amount > 0 ? 'income' : 'expense';
                  return (
                    <li
                      key={item.id}
                      id={`rec-${item.id}`}
                      className={cn(
                        'grid grid-cols-1 transition-[grid-template-rows,opacity] duration-[180ms] ease-out motion-reduce:transition-none',
                        leaving === item.id
                          ? 'grid-rows-[0fr] opacity-0'
                          : 'grid-rows-[1fr] opacity-100',
                      )}
                    >
                      <div className="min-h-0 overflow-hidden">
                        <Card
                          pad="sm"
                          className={cn(
                            'grid grid-cols-1 gap-2 md:p-4',
                            'lg:min-h-16 lg:items-center lg:rounded-none lg:bg-transparent lg:px-4 lg:py-2 lg:shadow-none',
                            CONFIRM_COLUMNS,
                          )}
                        >
                          <div className="min-w-0 lg:col-start-1">
                            <p className="truncate text-base font-medium" title={item.name}>
                              {truncateName(item.name, 60)}
                            </p>
                            <p className="hidden truncate text-label font-normal text-muted-foreground lg:block">
                              {item.lastSeenOn
                                ? t('lastSeen', { date: formatDate(item.lastSeenOn, locale) })
                                : t('lastSeenUnknown')}
                            </p>
                          </div>
                          <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground lg:hidden">
                            <MoneyAmount
                              minor={item.amount}
                              currency={item.currency}
                              kind={kind}
                              size="sm"
                            />
                            <span aria-hidden="true">·</span>
                            <span>{cadenceLabel(item)}</span>
                          </p>
                          <p className="text-sm text-muted-foreground lg:hidden">
                            {item.lastSeenOn
                              ? t('lastSeen', { date: formatDate(item.lastSeenOn, locale) })
                              : t('lastSeenUnknown')}
                            {item.nextExpectedOn
                              ? ` · ${t('nextAround', { date: formatDate(item.nextExpectedOn, locale) })}`
                              : ''}
                          </p>
                          <div className="min-w-0 lg:col-start-2">
                            {account ? <AccountBadge name={account.name} /> : null}
                          </div>
                          <p className="hidden truncate text-sm lg:col-start-3 lg:block">
                            {cadenceLabel(item)}
                          </p>
                          <p className="hidden text-sm lg:col-start-4 lg:block">
                            {item.nextExpectedOn
                              ? formatDate(item.nextExpectedOn, locale)
                              : t('nextUnknown')}
                          </p>
                          <div className="hidden text-right lg:col-start-5 lg:block">
                            <MoneyAmount
                              minor={item.amount}
                              currency={item.currency}
                              kind={kind}
                              size="sm"
                            />
                          </div>
                          {canWrite ? (
                            <div className="flex items-center gap-2 pt-1 lg:col-start-6 lg:justify-end lg:pt-0">
                              <Button
                                id={`confirm-${item.id}`}
                                variant="outline"
                                onClick={() => decide(item, 'confirm')}
                                aria-label={t('confirmNamed', { name: truncateName(item.name) })}
                              >
                                {t('confirm')}
                              </Button>
                              <DropdownMenu.Root>
                                <DropdownMenu.Trigger asChild>
                                  <Button
                                    id={`rec-more-${item.id}`}
                                    variant="ghost"
                                    size="icon"
                                    aria-label={t('moreNamed', { name: truncateName(item.name) })}
                                  >
                                    <MoreHorizontal className="size-5" aria-hidden="true" />
                                  </Button>
                                </DropdownMenu.Trigger>
                                <DropdownMenu.Portal>
                                  <DropdownMenu.Content
                                    align="end"
                                    sideOffset={6}
                                    className="z-50 min-w-44 rounded-lg bg-surface-raised p-1 shadow-raised"
                                  >
                                    <DropdownMenu.Item
                                      className={MENU_ITEM}
                                      onSelect={() => openItem(item, `rec-more-${item.id}`)}
                                      aria-label={t('editNamed', {
                                        name: truncateName(item.name),
                                      })}
                                    >
                                      <Pencil
                                        className="size-4 text-muted-foreground"
                                        aria-hidden="true"
                                      />
                                      {t('edit')}
                                    </DropdownMenu.Item>
                                    <DropdownMenu.Item
                                      className={MENU_ITEM}
                                      onSelect={() => decide(item, 'dismiss')}
                                      aria-label={t('dismissNamed', {
                                        name: truncateName(item.name),
                                      })}
                                    >
                                      <X
                                        className="size-4 text-muted-foreground"
                                        aria-hidden="true"
                                      />
                                      {t('dismiss')}
                                    </DropdownMenu.Item>
                                  </DropdownMenu.Content>
                                </DropdownMenu.Portal>
                              </DropdownMenu.Root>
                            </div>
                          ) : null}
                        </Card>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
        ) : null}

        <section aria-labelledby="fixed" className="grid grid-cols-1 gap-2">
          <h2
            id="fixed"
            ref={confirmedHeading}
            tabIndex={-1}
            className="text-heading outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t('fixedTitle')}
          </h2>
          {established.length === 0 ? (
            <Card pad="sm" className="text-base text-muted-foreground">
              {t('nothingConfirmed')}
            </Card>
          ) : (
            <Card pad="none" className="overflow-hidden">
              <div
                aria-hidden="true"
                className={cn(
                  'hidden h-10 items-center border-b border-border bg-surface-2 px-4 text-label font-medium text-muted-foreground lg:grid',
                  FIXED_COLUMNS,
                )}
              >
                <span className={headCell}>{columns('name')}</span>
                <span className={headCell}>{columns('account')}</span>
                <span className={headCell}>{columns('cadence')}</span>
                <span className={headCell}>{columns('next')}</span>
                <span className={cn(headCell, 'text-right')}>{columns('amount')}</span>
              </div>
              <ul className="divide-y divide-border">
                {established.map((item) => {
                  const overdue = isOverdue(item.nextExpectedOn, today);
                  const monthly = Math.abs(perMonth(item));
                  const account = item.accountId ? accountById.get(item.accountId) : undefined;
                  const kind = item.amount > 0 ? 'income' : 'expense';
                  const perMonthText =
                    item.cadence !== 'monthly' ? t('perMonth', { amount: money(monthly) }) : '';
                  const overdueText = overdue
                    ? item.lastSeenOn
                      ? t('overdueSince', { date: formatDate(item.lastSeenOn, locale) })
                      : t('overdueExpected', { date: formatDate(item.nextExpectedOn!, locale) })
                    : null;
                  const nextText = item.nextExpectedOn
                    ? t('next', { date: formatDate(item.nextExpectedOn, locale) })
                    : t('nextUnknown');
                  const row = (
                    <>
                      <span className="grid grid-cols-1 gap-0.5 lg:hidden">
                        <span className="flex items-baseline justify-between gap-3">
                          <span
                            className="min-w-0 truncate text-base font-medium"
                            title={item.name}
                          >
                            {truncateName(item.name, 60)}
                          </span>
                          <MoneyAmount minor={item.amount} currency={item.currency} kind={kind} />
                        </span>
                        <span className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
                          <span>
                            {cadenceLabel(item)}
                            {perMonthText ? ` · ${perMonthText}` : ''}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{nextText}</span>
                        </span>
                        {overdueText ? (
                          <span className="flex items-center gap-1 text-sm font-medium text-warning">
                            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                            {overdueText}
                          </span>
                        ) : null}
                        <span className="text-label font-normal text-muted-foreground">
                          {sources(item.source)}
                        </span>
                      </span>
                      <span
                        className={cn(
                          'hidden w-full items-center text-left lg:grid',
                          FIXED_COLUMNS,
                        )}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium" title={item.name}>
                            {truncateName(item.name, 60)}
                          </span>
                          <span className="block truncate text-label font-normal text-muted-foreground">
                            {sources(item.source)}
                          </span>
                        </span>
                        <span className="min-w-0">
                          {account ? <AccountBadge name={account.name} /> : null}
                        </span>
                        <span className="min-w-0 text-sm">
                          {cadenceLabel(item)}
                          {perMonthText ? (
                            <span className="block text-label text-muted-foreground">
                              {perMonthText}
                            </span>
                          ) : null}
                        </span>
                        <span className="min-w-0 text-sm">
                          {item.nextExpectedOn
                            ? formatDate(item.nextExpectedOn, locale)
                            : t('nextUnknown')}
                          {overdueText ? (
                            <span className="flex items-start gap-1 text-label font-medium text-warning">
                              <AlertTriangle
                                className="mt-0.5 size-3.5 shrink-0"
                                aria-hidden="true"
                              />
                              {overdueText}
                            </span>
                          ) : null}
                        </span>
                        <span className="text-right">
                          <MoneyAmount
                            minor={item.amount}
                            currency={item.currency}
                            kind={kind}
                            size="sm"
                          />
                        </span>
                      </span>
                    </>
                  );
                  return (
                    <li key={item.id} id={`rec-${item.id}`}>
                      {canWrite ? (
                        <button
                          type="button"
                          onClick={() => openItem(item)}
                          className="grid min-h-16 w-full grid-cols-1 px-4 py-3 text-left transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring lg:py-2"
                        >
                          {row}
                        </button>
                      ) : (
                        <div className="grid min-h-16 grid-cols-1 px-4 py-3 lg:py-2">{row}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </section>

        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            {t('monthlyCostHelp')} {t('manualNote')} {t('runsDaily')}
          </span>
        </p>
        {sheet}
      </div>
    </PageContainer>
  );
}
