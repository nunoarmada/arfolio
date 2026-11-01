'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Ban, Tag } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { shiftMonth } from '@/lib/net-worth-chart';
import { monthlySeries } from '@/lib/net-worth-series';
import { formatDayYear } from '@/lib/net-worth-format';
import { formatRate } from '@/lib/net-worth-schedule';
import type { AssetDetail } from '@/server/net-worth-data';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { Alert } from '../ui/alert';
import { Button, buttonVariants } from '../ui/button';
import { Card } from '../ui/card';
import { AssetCredits } from './asset-credits';
import { AssetDetailsSummary } from './asset-details-fields';
import { AssetEstimate } from './asset-estimate';
import { HistoryChart } from './history-chart';
import { DisposeAssetSheet } from './dispose-asset-sheet';
import { HistoryList } from './history-list';
import { KindIcon } from './kind-icon';
import { AssetActions, RecordMenu } from './record-actions';
import { StatusBlock, useFocusAfterChange } from './status-block';
import { ValuationSheet } from './valuation-sheet';
import { useFormatMoney } from '@/components/privacy';

/** An asset's page: today's value and where it comes from, its history, and what writers can do. */
export function AssetDetailView({
  detail,
  canWrite,
  isOwner,
}: {
  detail: AssetDetail;
  canWrite: boolean;
  isOwner: boolean;
}) {
  const t = useTranslations('asset');
  const kinds = useTranslations('netWorth.kind');
  const net = useTranslations('netWorth');
  const { locale } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const { asset, entries, current, today, estimateFrom, linkedLiabilities, lastValueBefore } =
    detail;
  const { disposal } = asset;
  const historyId = useId();
  const [updating, setUpdating] = useState(false);
  const [selling, setSelling] = useState(false);
  const [writingOff, setWritingOff] = useState(false);
  const focus = useFocusAfterChange(disposal ? 'disposed' : 'live');
  const linked = asset.accountId !== null;
  const currentMonth = `${today.slice(0, 7)}-01`;

  // A sold or written-off asset's chart ends the month before it left: the drop to nothing in
  // the disposal month is not a loss in value.
  const chartEnd = disposal ? shiftMonth(`${disposal.date.slice(0, 7)}-01`, -1) : currentMonth;
  const series = useMemo(() => {
    if (linked) return [];
    const upTo = disposal
      ? entries.filter((e) => e.asOf.slice(0, 7) <= chartEnd.slice(0, 7))
      : entries;
    const last = [...upTo].sort((a, b) => b.asOf.localeCompare(a.asOf))[0];
    return monthlySeries(
      upTo.map((e) => ({ asOf: e.asOf, amount: e.amount })),
      chartEnd,
      disposal ? (last?.amount ?? 0) : current.amount,
    );
  }, [linked, entries, chartEnd, disposal, current.amount]);

  const meta = linked
    ? t('metaLinked', { kind: kinds(asset.kind), account: asset.accountName ?? '' })
    : t('meta', { kind: kinds(asset.kind) });
  const day = (iso: string) => formatDayYear(iso, locale);
  const dated = (key: 'import' | 'connector' | 'ai' | 'manual', asOf: string | null) =>
    asOf ? t(`caption.${key}`, { date: day(asOf) }) : '';
  const sourceKey = (method: string | null) =>
    method === 'import' || method === 'connector' || method === 'ai' ? method : 'manual';
  // A sold or written-off asset shows the last value recorded before it left.
  const caption = disposal
    ? lastValueBefore
      ? dated(sourceKey(lastValueBefore.method), lastValueBefore.asOf)
      : t('caption.none')
    : !current.hasValue
      ? t('caption.none')
      : current.method === 'account'
        ? t('caption.account', { account: asset.accountName ?? '' })
        : estimateFrom
          ? t('caption.depreciation')
          : dated(sourceKey(current.method), current.asOf);
  const heroValue = disposal
    ? lastValueBefore
      ? { has: true, amount: lastValueBefore.amount }
      : { has: false, amount: 0 }
    : { has: current.hasValue, amount: current.amount };
  const heroLabel = disposal
    ? t(disposal.kind === 'sold' ? 'status.lastBeforeSale' : 'status.lastBeforeWriteOff')
    : t('currentValue');

  const updateButton =
    canWrite && !linked && !disposal ? (
      <Button className="w-full min-[360px]:w-auto" onClick={() => setUpdating(true)}>
        {t('update')}
      </Button>
    ) : null;

  return (
    <div className="grid grid-cols-1 gap-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 xl:gap-6">
        <div className="grid min-w-0 grid-cols-1 content-start gap-4 lg:col-span-5 xl:col-span-4">
          {disposal ? (
            <StatusBlock
              icon={disposal.kind === 'sold' ? Tag : Ban}
              headingRef={focus.statusRef}
              heading={
                disposal.kind === 'written_off'
                  ? t('status.writtenOff', { date: day(disposal.date) })
                  : disposal.saleAmount !== null
                    ? t('status.soldFor', {
                        date: day(disposal.date),
                        amount: formatMoney(disposal.saleAmount, asset.currency, locale),
                      })
                    : t('status.sold', { date: day(disposal.date) })
              }
            >
              <p className="text-sm text-muted-foreground">{t('status.stopped')}</p>
              {disposal.kind === 'sold' ? (
                disposal.saleTransaction ? (
                  <Link
                    href={`/transactions/${disposal.saleTransaction.id}`}
                    className="inline-flex min-h-11 items-center justify-self-start text-sm font-medium text-primary-text underline underline-offset-4"
                  >
                    {t('status.viewSale')}
                  </Link>
                ) : (
                  <p className="text-sm text-muted-foreground">{t('status.byHand')}</p>
                )
              ) : null}
            </StatusBlock>
          ) : null}

          <Card
            as="section"
            variant="hero"
            aria-labelledby="asset-hero-label"
            className="grid grid-cols-1 gap-3"
          >
            <div className="flex min-w-0 items-center gap-3">
              <KindIcon side="asset" kind={asset.kind} size={36} />
              <p className="min-w-0 flex-1 text-sm text-muted-foreground">{meta}</p>
              {canWrite && isOwner ? (
                <RecordMenu
                  mode="asset"
                  id={asset.id}
                  name={asset.name}
                  live={disposal === null}
                  hasLinkedCredits={linkedLiabilities.length > 0}
                />
              ) : null}
            </div>
            <p
              id="asset-hero-label"
              className="flex flex-wrap items-center gap-2 text-label text-muted-foreground"
            >
              {heroLabel}
              {asset.foreign ? (
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-caption font-medium text-foreground">
                  {net('outsideTotal')}
                </span>
              ) : null}
            </p>
            <div data-testid="detail-value">
              {heroValue.has ? (
                <MoneyAmount
                  minor={heroValue.amount}
                  currency={asset.currency}
                  kind="balance"
                  size="kpi"
                  dimCents
                  className="text-[32px] leading-9 md:text-[36px] md:leading-10 lg:text-[30px] lg:leading-9 xl:text-[34px] xl:leading-10 min-[1400px]:text-[34px] min-[1400px]:leading-10"
                />
              ) : (
                <span className="text-[32px] font-semibold leading-9 text-muted-foreground">—</span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{caption}</p>
            {!disposal && estimateFrom && asset.depreciationBps !== null ? (
              <p className="max-w-[68ch] text-sm text-muted-foreground">
                {t('depreciationNote', {
                  value: formatMoney(estimateFrom.amount, asset.currency, locale),
                  date: day(estimateFrom.asOf),
                  rate: formatRate(asset.depreciationBps, locale, { trim: true }),
                })}
              </p>
            ) : null}
            {!disposal && linked ? (
              <Alert
                tone="info"
                action={
                  <Link
                    href={`/accounts/${asset.accountId}`}
                    className={buttonVariants({ variant: 'outline' })}
                  >
                    {t('viewAccount')}
                  </Link>
                }
              >
                {t('linkedNotice', { account: asset.accountName ?? '' })}
              </Alert>
            ) : null}
            <AssetActions
              asset={asset}
              disposalKind={disposal?.kind ?? null}
              settledLinkedCount={detail.settledLinkedCount}
              canWrite={canWrite}
              primary={updateButton}
              onSell={() => setSelling(true)}
              onWriteOff={() => setWritingOff(true)}
              onUndone={focus.focusTitleNext}
            />
          </Card>

          {disposal && linkedLiabilities.length > 0 ? (
            <Alert tone="info">
              {t('status.openCredits', { count: linkedLiabilities.length })}
              <ul className="mt-1 grid grid-cols-1">
                {linkedLiabilities.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/net-worth/liabilities/${c.id}`}
                      className="inline-flex min-h-11 items-center font-medium text-primary-text underline underline-offset-4"
                    >
                      {c.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}

          {disposal ? null : <AssetEstimate detail={detail} canWrite={canWrite} />}

          {!disposal && linkedLiabilities.length > 0 ? (
            <AssetCredits
              credits={linkedLiabilities}
              equity={detail.equity}
              currency={asset.currency}
              assetForeign={asset.foreign}
            />
          ) : null}

          <AssetDetailsSummary kind={asset.kind} details={asset.details} />
        </div>

        <section
          aria-labelledby={historyId}
          className="grid min-w-0 grid-cols-1 content-start gap-3 lg:col-span-7 xl:col-span-8"
        >
          <h2 id={historyId} tabIndex={-1} className="text-heading outline-none">
            {t('history')}
          </h2>
          {series.length >= 2 ? (
            <Card>
              <HistoryChart
                rows={series}
                scale={{ start: series[0]!.month, count: series.length }}
                currentMonth={chartEnd}
                compact
                caption={false}
                record={asset.name}
              />
            </Card>
          ) : null}
          {entries.length === 0 ? (
            <Card className="grid grid-cols-1 justify-items-start gap-2">
              <p className="text-base text-muted-foreground">{t('historyEmpty')}</p>
              {canWrite && !linked && !disposal ? (
                <Button variant="outline" onClick={() => setUpdating(true)}>
                  {t('update')}
                </Button>
              ) : null}
            </Card>
          ) : (
            <HistoryList
              mode="asset"
              entries={entries}
              currency={asset.currency}
              canWrite={canWrite}
              headingId={historyId}
            />
          )}
        </section>
      </div>

      {canWrite && !disposal ? (
        <>
          <DisposeAssetSheet
            mode="sold"
            open={selling}
            onOpenChange={setSelling}
            asset={asset}
            credits={linkedLiabilities}
            today={today}
            onDone={focus.focusStatusNext}
          />
          <DisposeAssetSheet
            mode="written_off"
            open={writingOff}
            onOpenChange={setWritingOff}
            asset={asset}
            credits={linkedLiabilities}
            today={today}
            onDone={focus.focusStatusNext}
          />
        </>
      ) : null}

      {canWrite && !linked && !disposal ? (
        <ValuationSheet
          mode="asset"
          recordId={asset.id}
          today={today}
          existingDates={entries.map((e) => e.asOf)}
          open={updating}
          onOpenChange={setUpdating}
        />
      ) : null}
    </div>
  );
}
