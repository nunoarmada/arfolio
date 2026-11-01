'use client';

import { Clock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useHouseholdFormat } from './household-format';
import { useFormatMoney, usePrivacy } from './privacy';

export type MoneyKind = 'expense' | 'income' | 'transfer' | 'balance' | 'neutral';
export type MoneySize = 'sm' | 'md' | 'lg' | 'kpi' | 'hero';

const MINUS = '−';

const SIZE: Record<MoneySize, string> = {
  sm: 'text-sm font-medium',
  md: 'text-base font-medium',
  lg: 'text-2xl font-semibold',
  /** KPI tiles: 22px on phones, then the `kpi` step of the type scale. */
  kpi: 'money-hero text-[26px] leading-8 font-semibold tracking-[-0.025em] max-sm:text-[22px] max-sm:leading-7 max-[389px]:text-[20px] min-[1400px]:text-[30px] min-[1400px]:leading-9',
  hero: 'money-hero text-[36px] leading-10 font-semibold md:text-[44px] md:leading-[48px]',
};

/** The decimal separator the locale uses for this currency, to dim the cents on hero amounts. */
function decimalOf(locale: string, currency: string): string {
  return (
    new Intl.NumberFormat(locale, { style: 'currency', currency })
      .formatToParts(1.5)
      .find((p) => p.type === 'decimal')?.value ?? '.'
  );
}

/**
 * Money, formatted by the one shared function with the household locale. The sign follows meaning
 * (expense, income, transfer), colour is calm by default, and a visually hidden prefix names the
 * meaning because glyph and colour alone are not reliable.
 */
export function MoneyAmount({
  minor,
  currency,
  kind = 'neutral',
  pending = false,
  size = 'md',
  showSign,
  compact = false,
  dimCents = false,
  className,
}: {
  minor: number;
  currency: string;
  kind?: MoneyKind;
  pending?: boolean;
  size?: MoneySize;
  /** Overrides the default sign rule of the kind (transfers show none by default). */
  showSign?: boolean;
  compact?: boolean;
  /** Hero and KPI amounts only: cents at 60% size in the muted colour. */
  dimCents?: boolean;
  className?: string;
}) {
  const t = useTranslations('money');
  const { locale } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const { hidden } = usePrivacy();
  const abs = Math.abs(minor);
  const negative = minor < 0;

  const sign = (() => {
    // Zero is neither spending nor income: no sign, whatever the kind.
    if (minor === 0) return '';
    switch (kind) {
      case 'expense':
        return showSign === false ? '' : MINUS;
      case 'income':
        return showSign === false ? '' : '+';
      case 'transfer':
        return showSign ? (negative ? MINUS : '+') : '';
      default:
        return negative && showSign !== false ? MINUS : '';
    }
  })();

  const tone =
    pending || minor === 0
      ? 'text-muted-foreground'
      : kind === 'income'
        ? 'text-positive'
        : kind === 'transfer'
          ? 'text-transfer'
          : kind === 'balance' && negative
            ? 'text-negative'
            : 'text-foreground';

  const text = formatMoney(abs, currency, locale, { compact });
  const meaning = kind === 'expense' || kind === 'income' || kind === 'transfer' ? t(kind) : null;

  let body: ReactNode = text;
  if (dimCents && (size === 'hero' || size === 'kpi') && !compact && !hidden) {
    const sep = decimalOf(locale, currency);
    const at = text.lastIndexOf(sep);
    const tail = at >= 0 ? text.slice(at).match(/^.\d+/)?.[0] : undefined;
    if (at >= 0 && tail) {
      body = (
        <>
          {text.slice(0, at)}
          <span className="text-[0.6em] text-muted-foreground">{tail}</span>
          {text.slice(at + tail.length)}
        </>
      );
    }
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap tabular-nums',
        SIZE[size],
        tone,
        className,
      )}
    >
      {pending ? <Clock className="size-3.5 shrink-0" aria-hidden="true" /> : null}
      {meaning || pending ? (
        <span className="sr-only">
          {[pending ? t('pending') : null, meaning].filter(Boolean).join(', ')}{' '}
        </span>
      ) : null}
      <span>
        {sign}
        {body}
      </span>
    </span>
  );
}
