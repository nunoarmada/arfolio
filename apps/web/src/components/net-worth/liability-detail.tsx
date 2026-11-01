'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { CircleCheck } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { monthlySeries } from '@/lib/net-worth-series';
import { formatDayYear } from '@/lib/net-worth-format';
import type { LiabilityDetail } from '@/server/net-worth-data';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { Alert } from '../ui/alert';
import { Button, buttonVariants } from '../ui/button';
import { Card } from '../ui/card';
import { HistoryChart } from './history-chart';
import { HistoryList } from './history-list';
import { KindIcon } from './kind-icon';
import { LiabilityActions, RecordMenu } from './record-actions';
import { ScheduleCard } from './schedule-card';
import { SettleLiabilitySheet } from './settle-liability-sheet';
import { StatusBlock, useFocusAfterChange } from './status-block';
import { ValuationSheet } from './valuation-sheet';

/** A liability's page: what is owed and why we think so, its plan, its balances and the actions. */
export function LiabilityDetailView({
  detail,
  canWrite,
  isOwner,
}: {
  detail: LiabilityDetail;
  canWrite: boolean;
  isOwner: boolean;
}) {
  const t = useTranslations('liability');
  const kinds = useTranslations('netWorth.kind');
  const net = useTranslations('netWorth');
  const { locale } = useHouseholdFormat();
  const { liability, entries, current, today, schedule, divergence, lastBalance } = detail;
  const historyId = useId();
  const [updating, setUpdating] = useState(false);
  const [settling, setSettling] = useState(false);
  const { settledOn, assetDisposal } = liability;
  const focus = useFocusAfterChange(settledOn ? 'settled' : 'live');
  const linked = liability.accountId !== null;
  const currentMonth = `${today.slice(0, 7)}-01`;
  const day = (iso: string) => formatDayYear(iso, locale);

  const series = useMemo(
    () =>
      linked
        ? []
        : monthlySeries(
            entries.map((e) => ({ asOf: e.asOf, amount: e.amount })),
            currentMonth,
            current.amount,
          ),
    [linked, entries, currentMonth, current.amount],
  );

  const kind = kinds(liability.kind);
  const meta = linked
    ? t('metaLinked', { kind, account: liability.accountName ?? '' })
    : liability.assetId && liability.assetName
      ? t.rich('metaAsset', {
          kind,
          name: liability.assetName,
          asset: (chunks) => (
            <>
              <Link
                href={`/net-worth/assets/${liability.assetId}`}
                className="font-medium text-primary-text underline underline-offset-4"
              >
                {chunks}
              </Link>
              {/* "(vendido)", "(abatido)" or "(arquivado)" once the asset is gone */}
              {assetDisposal
                ? t(assetDisposal.kind === 'sold' ? 'assetSoldSuffix' : 'assetWrittenOffSuffix')
                : liability.assetArchived
                  ? t('assetArchivedSuffix')
                  : ''}
            </>
          ),
        })
      : t('meta', { kind });

  const cap = current.caption;
  const caption = settledOn
    ? lastBalance
      ? t('caption.recorded', { date: day(lastBalance.asOf) })
      : t('caption.none')
    : cap.kind === 'account'
      ? t('caption.account', { account: liability.accountName ?? '' })
      : cap.kind === 'bank'
        ? t('caption.bank', { date: day(cap.asOf) })
        : cap.kind === 'recorded'
          ? t('caption.recorded', { date: day(cap.asOf) })
          : cap.kind === 'schedule'
            ? t('caption.schedule')
            : cap.kind === 'principal'
              ? t('caption.principal')
              : t('caption.none');
  const showSchedule =
    !settledOn && (schedule !== null || liability.kind === 'mortgage' || liability.kind === 'loan');
  const hero = settledOn
    ? { has: lastBalance !== null, amount: lastBalance?.amount ?? 0 }
    : { has: current.hasValue, amount: current.amount };
  const zeroStays =
    settledOn !== null && entries.some((e) => e.asOf === settledOn && e.amount === 0);

  const updateButton =
    canWrite && !linked && !settledOn ? (
      <Button className="w-full min-[360px]:w-auto" onClick={() => setUpdating(true)}>
        {t('update')}
      </Button>
    ) : null;

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 xl:gap-6">
        <div className="grid min-w-0 grid-cols-1 content-start gap-4 lg:col-span-5 xl:col-span-4">
          {settledOn ? (
            <StatusBlock
              icon={CircleCheck}
              headingRef={focus.statusRef}
              heading={t('status.settled', { date: day(settledOn) })}
            >
              <p className="text-sm text-muted-foreground">{t('status.stopped')}</p>
            </StatusBlock>
          ) : null}

          <Card
            as="section"
            variant="hero"
            aria-labelledby="liability-hero-label"
            className="grid grid-cols-1 gap-3"
          >
            <div className="flex min-w-0 items-center gap-3">
              <KindIcon side="liability" kind={liability.kind} size={36} />
              <p className="min-w-0 flex-1 text-sm text-muted-foreground">{meta}</p>
              {canWrite && isOwner ? (
                <RecordMenu
                  mode="liability"
                  id={liability.id}
                  name={liability.name}
                  live={settledOn === null}
                />
              ) : null}
            </div>
            <p
              id="liability-hero-label"
              className="flex flex-wrap items-center gap-2 text-label text-muted-foreground"
            >
              {settledOn ? t('status.lastBalance') : t('currentValue')}
              {liability.foreign ? (
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-caption font-medium text-foreground">
                  {net('outsideTotal')}
                </span>
              ) : null}
            </p>
            <div data-testid="detail-value">
              {hero.has ? (
                <MoneyAmount
                  minor={hero.amount}
                  currency={liability.currency}
                  kind="neutral"
                  size="kpi"
                  dimCents
                  className="text-[32px] leading-9 md:text-[36px] md:leading-10 lg:text-[30px] lg:leading-9 xl:text-[34px] xl:leading-10 min-[1400px]:text-[34px] min-[1400px]:leading-10"
                />
              ) : (
                <span className="text-[32px] font-semibold leading-9 text-muted-foreground">—</span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{caption}</p>
            {!settledOn && linked ? (
              <Alert
                tone="info"
                action={
                  <Link
                    href={`/accounts/${liability.accountId}`}
                    className={buttonVariants({ variant: 'outline' })}
                  >
                    {t('viewAccount')}
                  </Link>
                }
              >
                {t('linkedNotice', { account: liability.accountName ?? '' })}
              </Alert>
            ) : null}
            <LiabilityActions
              liability={liability}
              settled={settledOn !== null}
              zeroStays={zeroStays}
              canWrite={canWrite}
              primary={updateButton}
              onSettle={() => setSettling(true)}
              onUndone={focus.focusTitleNext}
            />
          </Card>

          {!settledOn && assetDisposal && liability.assetName ? (
            <Alert
              tone="info"
              action={
                canWrite ? (
                  <Button variant="outline" onClick={() => setSettling(true)}>
                    {t('actions.settle')}
                  </Button>
                ) : undefined
              }
            >
              {t(assetDisposal.kind === 'sold' ? 'status.assetSold' : 'status.assetWrittenOff', {
                asset: liability.assetName,
                date: day(assetDisposal.date),
              })}
            </Alert>
          ) : null}
        </div>

        <div className="grid min-w-0 grid-cols-1 content-start gap-4 lg:col-span-7 xl:col-span-8 xl:gap-6">
          {series.length >= 2 ? (
            <Card>
              <HistoryChart
                rows={series}
                scale={{ start: series[0]!.month, count: series.length }}
                currentMonth={currentMonth}
                compact
                caption={false}
                record={liability.name}
              />
            </Card>
          ) : null}

          {showSchedule ? (
            <ScheduleCard
              schedule={schedule}
              currency={liability.currency}
              currentBalance={current.hasValue ? current.amount : (schedule?.planBalance ?? 0)}
              today={today}
              divergence={divergence}
              canWrite={canWrite}
              editHref={`/net-worth/liabilities/${liability.id}/edit#schedule`}
            />
          ) : null}

          <section aria-labelledby={historyId} className="grid grid-cols-1 content-start gap-3">
            <h2 id={historyId} tabIndex={-1} className="text-heading outline-none">
              {t('history')}
            </h2>
            {entries.length === 0 ? (
              <Card className="grid grid-cols-1 justify-items-start gap-2">
                <p className="text-base text-muted-foreground">{t('historyEmpty')}</p>
                {canWrite && !linked && !settledOn ? (
                  <Button variant="outline" onClick={() => setUpdating(true)}>
                    {t('update')}
                  </Button>
                ) : null}
              </Card>
            ) : (
              <HistoryList
                mode="liability"
                entries={entries}
                currency={liability.currency}
                canWrite={canWrite}
                headingId={historyId}
              />
            )}
          </section>
        </div>
      </div>

      {canWrite && !settledOn ? (
        <SettleLiabilitySheet
          open={settling}
          onOpenChange={setSettling}
          liability={liability}
          today={today}
          existingDates={entries.map((e) => e.asOf)}
          onDone={focus.focusStatusNext}
        />
      ) : null}

      {canWrite && !linked && !settledOn ? (
        <ValuationSheet
          mode="liability"
          recordId={liability.id}
          today={today}
          existingDates={entries.map((e) => e.asOf)}
          open={updating}
          onOpenChange={setUpdating}
        />
      ) : null}
    </div>
  );
}
