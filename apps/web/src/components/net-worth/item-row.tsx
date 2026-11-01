'use client';

import { ChevronRight, CornerDownRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { formatDayYear } from '@/lib/net-worth-format';
import type { ItemRow as ItemRowModel, Subtitle } from '@/lib/net-worth-items';
import { formatRate } from '@/lib/net-worth-schedule';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { KindIcon } from './kind-icon';

/** The words for a row's second line. */
export function useSubtitleText() {
  const t = useTranslations('netWorth');
  const { locale } = useHouseholdFormat();
  return (subtitle: Subtitle, canWrite: boolean): string => {
    const day = (iso: string | null) => (iso ? formatDayYear(iso, locale) : '');
    switch (subtitle.kind) {
      case 'manual':
      case 'import':
      case 'connector':
      case 'ai':
        return subtitle.asOf
          ? t(`source.${subtitle.kind}`, { date: day(subtitle.asOf) })
          : t(`source.${subtitle.kind}`, { date: '—' });
      case 'depreciation':
        return t('source.depreciation', { rate: formatRate(subtitle.bps, locale, { trim: true }) });
      case 'schedule':
        return t('source.schedule');
      case 'principal':
        return t('source.principal');
      case 'account':
        return subtitle.asOf
          ? t('source.account', { freshness: day(subtitle.asOf) })
          : t('source.accountNoDate');
      case 'via':
        return t('source.via', {
          account: subtitle.account,
          freshness: subtitle.asOf ? day(subtitle.asOf) : t('noValue'),
        });
      case 'noValue':
        return canWrite ? t('noValueHint') : t('noValue');
    }
  };
}

const CHIP = 'shrink-0 rounded-sm bg-surface-3 px-2 py-0.5 text-xs font-medium text-foreground';

/**
 * One asset, liability or account: a 64px row that is a link to its page. An asset with unsettled
 * linked credits also carries them (`credits` holds the Passivos rows by id) and its equity.
 */
export function ItemRow({
  row,
  canWrite,
  credits,
}: {
  row: ItemRowModel;
  canWrite: boolean;
  credits?: ReadonlyMap<string, ItemRowModel>;
}) {
  const t = useTranslations('netWorth');
  const money = useTranslations('money');
  const subtitle = useSubtitleText();
  const owed = row.side === 'liability';
  const second = subtitle(row.subtitle, canWrite);
  const secondLine =
    !owed || !row.assetName
      ? second
      : t(
          row.assetSold
            ? row.assetWrittenOff
              ? 'linkedTo.writtenOff'
              : 'linkedTo.sold'
            : row.assetArchived
              ? 'linkedTo.archived'
              : 'linkedTo.live',
          { asset: row.assetName, subtitle: second },
        );
  const nested = (row.linkedLiabilities ?? []).flatMap((c) => {
    const credit = credits?.get(c.refId);
    return credit ? [credit] : [];
  });
  return (
    <li data-testid={`nw-item-${row.refId}`}>
      <Link
        href={row.href}
        className="flex min-h-16 items-center gap-3 px-4 py-2 outline-none transition-colors duration-[120ms] hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:px-5"
      >
        <KindIcon side={row.side} kind={row.kind} className="max-sm:hidden" />
        <span className="grid grid-cols-1 min-w-0 flex-1 justify-items-start">
          {/* Two lines on phones, where the amount takes a third of the row; one from sm. */}
          <span
            className="line-clamp-2 break-words text-base font-medium sm:line-clamp-1"
            title={row.title}
          >
            {row.title}
          </span>
          <span className="line-clamp-2 text-sm text-muted-foreground">{secondLine}</span>
          {row.foreign ? (
            <span className={`${CHIP} mt-1 sm:hidden`}>{t('outsideTotal')}</span>
          ) : null}
        </span>
        {row.foreign ? <span className={`${CHIP} max-sm:hidden`}>{t('outsideTotal')}</span> : null}
        {row.hasValue ? (
          <span className="flex shrink-0 items-center">
            {owed ? <span className="sr-only">{money('owed')} </span> : null}
            <MoneyAmount
              minor={row.amount}
              currency={row.currency}
              kind={owed ? 'neutral' : 'balance'}
              className={cn('max-sm:text-sm', row.foreign && 'text-muted-foreground')}
            />
          </span>
        ) : (
          <span className="max-w-[7rem] shrink-0 text-right text-sm text-muted-foreground">
            {t('noValue')}
          </span>
        )}
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground sm:size-5"
          aria-hidden="true"
        />
      </Link>
      {nested.length > 0 ? (
        <LinkedCredits asset={row} credits={nested} canWrite={canWrite} />
      ) : null}
    </li>
  );
}

/** Left padding that lines nested text up with the asset's title (icon 40 + gaps from sm). */
const INDENT = 'pl-10 sm:pl-[68px] md:pl-[72px]';

/** The credits under an asset row, then the equity line (text, not a link). */
function LinkedCredits({
  asset,
  credits,
  canWrite,
}: {
  asset: ItemRowModel;
  credits: ItemRowModel[];
  canWrite: boolean;
}) {
  const t = useTranslations('netWorth');
  const kinds = useTranslations('netWorth.kind');
  const money = useTranslations('money');
  const subtitle = useSubtitleText();
  return (
    <>
      <ul aria-label={t('nested.creditsOf', { asset: asset.title })}>
        {credits.map((credit) => (
          <li key={credit.key} data-testid={`nw-credit-${credit.refId}`} className="relative">
            <span
              aria-hidden="true"
              className="absolute right-0 top-0 left-10 border-t border-border sm:left-[68px] md:left-[72px]"
            />
            <Link
              href={credit.href}
              className={cn(
                'relative flex min-h-14 items-center gap-3 py-2 pr-4 outline-none transition-colors duration-[120ms] hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:pr-5',
                INDENT,
              )}
            >
              <CornerDownRight
                className="absolute left-4 top-4 size-4 text-muted-foreground sm:left-7 md:left-8"
                aria-hidden="true"
              />
              <span className="grid min-w-0 flex-1 grid-cols-1">
                <span
                  className="line-clamp-2 break-words text-base font-medium sm:line-clamp-1"
                  title={credit.title}
                >
                  {credit.title}
                </span>
                <span className="line-clamp-2 text-sm text-muted-foreground">
                  {kinds(credit.kind)} · {subtitle(credit.subtitle, canWrite)}
                </span>
              </span>
              {credit.hasValue ? (
                <span className="flex shrink-0 items-center">
                  <span className="sr-only">{money('owed')} </span>
                  <MoneyAmount
                    minor={-credit.amount}
                    currency={credit.currency}
                    kind="neutral"
                    size="sm"
                    className="text-muted-foreground"
                  />
                </span>
              ) : (
                <span className="max-w-[7rem] shrink-0 text-right text-sm text-muted-foreground">
                  {t('noValue')}
                </span>
              )}
              <ChevronRight
                className="size-4 shrink-0 text-muted-foreground sm:size-5"
                aria-hidden="true"
              />
            </Link>
          </li>
        ))}
      </ul>
      <p
        data-testid={`nw-equity-${asset.refId}`}
        className={cn(
          'flex min-h-12 items-center justify-between gap-3 border-t border-dashed border-border pr-4 md:pr-5',
          INDENT,
        )}
      >
        <span className="text-sm font-medium">{t('nested.equity')}</span>
        {asset.equity != null ? (
          <MoneyAmount
            minor={asset.equity}
            currency={asset.currency}
            kind="balance"
            size="sm"
            className="font-semibold"
          />
        ) : (
          <span className="text-sm text-muted-foreground">
            <span aria-hidden="true">—</span>
            <span className="sr-only">{t('nested.equityUnavailable')}</span>
          </span>
        )}
      </p>
    </>
  );
}
