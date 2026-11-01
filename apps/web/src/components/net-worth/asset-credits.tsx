'use client';

import { ChevronRight, CornerDownRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { formatDayYear } from '@/lib/net-worth-format';
import type { LinkedLiabilityDto } from '@/server/net-worth-data';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { Card } from '../ui/card';

/**
 * "Créditos ligados" on a live asset's page: the unsettled credits linked to it, in the anatomy
 * of the nested rows on the Resumo, and the equity (with the reason when it is unavailable).
 */
export function AssetCredits({
  credits,
  equity,
  currency,
  assetForeign,
}: {
  credits: LinkedLiabilityDto[];
  equity: number | null;
  currency: string;
  assetForeign: boolean;
}) {
  const t = useTranslations('asset');
  const nw = useTranslations('netWorth');
  const kinds = useTranslations('netWorth.kind');
  const liability = useTranslations('liability');
  const money = useTranslations('money');
  const { locale } = useHouseholdFormat();
  const otherCurrency = assetForeign || credits.some((c) => c.foreign);
  return (
    <Card
      as="section"
      aria-labelledby="asset-credits-title"
      pad="none"
      className="grid grid-cols-1 overflow-hidden"
    >
      <h2 id="asset-credits-title" className="px-4 pb-2 pt-4 text-card-title md:px-5 md:pt-5">
        {t('sections.credits')}
      </h2>
      <div className="border-t border-border">
        <ul className="divide-y divide-border">
          {credits.map((c) => (
            <li key={c.id} data-testid={`asset-credit-${c.id}`}>
              <Link
                href={`/net-worth/liabilities/${c.id}`}
                className="flex min-h-14 items-center gap-3 px-4 py-2 outline-none transition-colors duration-[120ms] hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:px-5"
              >
                <CornerDownRight
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="grid min-w-0 flex-1 grid-cols-1">
                  <span className="line-clamp-2 break-words text-base font-medium" title={c.name}>
                    {c.name}
                  </span>
                  <span className="line-clamp-2 text-sm text-muted-foreground">
                    {kinds(c.kind)}
                    {c.hasValue && c.asOf
                      ? ` · ${liability('caption.recorded', { date: formatDayYear(c.asOf, locale) })}`
                      : ''}
                  </span>
                </span>
                {c.hasValue ? (
                  <span className="flex shrink-0 items-center">
                    <span className="sr-only">{money('owed')} </span>
                    <MoneyAmount
                      minor={-c.amount}
                      currency={c.currency}
                      kind="neutral"
                      size="sm"
                      className="text-muted-foreground"
                    />
                  </span>
                ) : (
                  <span className="max-w-[7rem] shrink-0 text-right text-sm text-muted-foreground">
                    {nw('noValue')}
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
          data-testid="asset-equity"
          className="flex min-h-12 items-center justify-between gap-3 border-t border-dashed border-border px-4 md:px-5"
        >
          <span className="text-sm font-medium">{nw('nested.equity')}</span>
          {equity !== null ? (
            <MoneyAmount
              minor={equity}
              currency={currency}
              kind="balance"
              size="sm"
              className="font-semibold"
            />
          ) : (
            <span className="text-sm text-muted-foreground">
              <span aria-hidden="true">—</span>
              <span className="sr-only">{nw('nested.equityUnavailable')}</span>
            </span>
          )}
        </p>
      </div>
      {equity === null ? (
        <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground md:px-5">
          {otherCurrency ? t('equityCurrency') : t('equityMissing')}
        </p>
      ) : null}
    </Card>
  );
}
