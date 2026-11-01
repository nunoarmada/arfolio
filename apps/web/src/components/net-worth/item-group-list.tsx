'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useId } from 'react';
import type { ItemGroup, ItemRow as ItemRowModel } from '@/lib/net-worth-items';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { Card } from '../ui/card';
import { shareText } from './net-worth-headline';
import { ItemRow } from './item-row';

/**
 * The Ativos or Passivos list: the side's total, then one group per kind with its subtotal.
 * Liability amounts are the positive amount owed, in the normal text colour: a mortgage is not
 * an alarm.
 */
export function ItemGroupList({
  side,
  total,
  groups,
  canWrite,
  credits,
}: {
  side: 'asset' | 'liability';
  total: number;
  groups: ItemGroup[];
  canWrite: boolean;
  /** Asset side: the Passivos rows by id, shown nested under the asset they are linked to. */
  credits?: ReadonlyMap<string, ItemRowModel>;
}) {
  const t = useTranslations('netWorth');
  const kinds = useTranslations(
    side === 'asset' ? 'netWorth.kinds.asset' : 'netWorth.kinds.liability',
  );
  const { currency, locale } = useHouseholdFormat();
  const titleId = useId();
  const owed = side === 'liability';
  const addHref = side === 'asset' ? '/net-worth/assets/new' : '/net-worth/liabilities/new';
  return (
    <section aria-labelledby={titleId} className="grid grid-cols-1 content-start gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={titleId} className="text-heading">
          {t(owed ? 'liabilities' : 'assets')}
        </h2>
        <MoneyAmount
          minor={total}
          currency={currency}
          kind={owed ? 'neutral' : 'balance'}
          size="lg"
        />
      </div>
      {groups.length === 0 ? (
        <Card className="text-base text-muted-foreground">
          {t(owed ? 'emptyLiabilities' : 'emptyAssets')}{' '}
          {canWrite ? (
            <Link
              href={addHref}
              className="inline-flex min-h-11 items-center font-medium text-primary-text underline-offset-4 hover:underline"
            >
              {t(owed ? 'addLiabilityAction' : 'addAssetAction')}
            </Link>
          ) : null}
        </Card>
      ) : (
        groups.map((group) => {
          const share = shareText(group.subtotal, total, locale);
          return (
            <Card key={group.kind} as="section" pad="none" className="overflow-hidden">
              <div className="flex items-baseline justify-between gap-3 px-4 pb-1 pt-4 md:px-5">
                <h3 className="text-card-title">{kinds(group.kind)}</h3>
                {group.rows.some((r) => r.hasValue && !r.foreign) ? (
                  <span className="flex items-baseline gap-2">
                    <MoneyAmount
                      minor={group.subtotal}
                      currency={currency}
                      kind={owed ? 'neutral' : 'balance'}
                      size="sm"
                    />
                    {share ? (
                      <span className="w-9 text-right text-caption tabular-nums text-muted-foreground">
                        {share}
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span aria-hidden="true" className="text-sm text-muted-foreground">
                    —
                  </span>
                )}
              </div>
              <ul className="divide-y divide-border">
                {group.rows.map((row) => (
                  <ItemRow key={row.key} row={row} canWrite={canWrite} credits={credits} />
                ))}
              </ul>
            </Card>
          );
        })
      )}
    </section>
  );
}
