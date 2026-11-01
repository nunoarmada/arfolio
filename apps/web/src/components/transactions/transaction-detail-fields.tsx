'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ibanEnding, groupIban, maskIban, type DetailField } from '@/lib/transaction-details-view';
import { CopyButton } from '../copy-button';
import { useHouseholdFormat } from '../household-format';
import { MoneyAmount } from '../money-amount';
import { Button } from '../ui/button';
import { Row } from './detail-row';
import { useFormatMoney, usePrivacy } from '@/components/privacy';

/**
 * An IBAN, masked until the person asks for it. The mask is hidden from assistive technology
 * (which hears only the ending); the copy button always copies the full number without spaces.
 */
export function IbanValue({ iban }: { iban: string }) {
  const t = useTranslations('transactions.iban');
  const [shown, setShown] = useState(false);
  return (
    <span className="grid grid-cols-1 justify-items-end">
      {shown ? (
        <span className="select-text break-all tabular-nums">{groupIban(iban)}</span>
      ) : (
        <>
          <span aria-hidden="true" className="tabular-nums">
            {maskIban(iban)}
          </span>
          <span className="sr-only">{t('maskedSr', { last: ibanEnding(iban) })}</span>
        </>
      )}
      <span className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="min-h-11 min-w-11 px-2"
          aria-label={shown ? t('hideLabel') : t('showLabel')}
          onClick={() => setShown((v) => !v)}
        >
          {shown ? (
            <EyeOff className="size-4" aria-hidden="true" />
          ) : (
            <Eye className="size-4" aria-hidden="true" />
          )}
          {shown ? t('hide') : t('show')}
        </Button>
        <CopyButton
          iconOnly
          variant="ghost"
          text={iban}
          label={t('copy')}
          copiedLabel={t('copied')}
        />
      </span>
    </span>
  );
}

const LABEL_KEY: Record<DetailField['id'], string> = {
  purchaseDate: 'purchaseDate',
  merchant: 'merchant',
  location: 'location',
  originalAmount: 'originalAmount',
  counterparty: 'toAccount',
  reference: 'reference',
  instrument: 'instrument',
  valueDate: 'valueDateLabel',
  mcc: 'mcc',
  remittance: 'remittance',
  bankCode: 'bankCode',
  bic: 'bic',
  balanceAfter: 'balanceAfter',
  providerType: 'providerType',
  providerCategory: 'providerCategory',
  original: 'original',
  source: 'source',
};

/** Renders one entry of the details model as a `Row`. */
export function DetailFieldRow({ field }: { field: DetailField }) {
  const t = useTranslations('transactions');
  const { locale } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const { hidden } = usePrivacy();
  const label = t(`field.${field.id === 'counterparty' ? field.label : LABEL_KEY[field.id]}`);

  switch (field.id) {
    case 'purchaseDate':
      return (
        <Row label={label}>
          {field.value}
          {field.bookedOn ? (
            <span className="block text-sm text-muted-foreground">
              {t('bookedOn', { date: field.bookedOn })}
            </span>
          ) : null}
        </Row>
      );
    case 'merchant':
      return (
        <Row label={label}>
          {field.name ? <span className="break-words">{field.name}</span> : null}
          {field.domain ? (
            <span
              className={field.name ? 'block break-all text-sm text-muted-foreground' : 'break-all'}
            >
              {field.domain}
            </span>
          ) : null}
        </Row>
      );
    case 'originalAmount':
      return (
        <Row label={label}>
          <MoneyAmount minor={field.amount} currency={field.currency} kind="neutral" />
          {field.rate ? (
            <span className="block text-sm text-muted-foreground">
              {t('exchangeRate', {
                from: field.rate.from,
                rate: field.rate.value,
                to: field.rate.to,
              })}
            </span>
          ) : null}
        </Row>
      );
    case 'counterparty':
      return (
        <Row label={label}>
          {field.iban ? (
            <IbanValue iban={field.iban} />
          ) : (
            <span className="select-text break-all">{field.other}</span>
          )}
        </Row>
      );
    case 'reference':
      return (
        <Row label={label}>
          <span className="flex items-center justify-end gap-1">
            <span className="select-text break-all">{field.value}</span>
            <CopyButton
              iconOnly
              variant="ghost"
              text={field.value}
              label={t('copyReference')}
              copiedLabel={t('referenceCopied')}
            />
          </span>
        </Row>
      );
    case 'instrument': {
      const price = field.price
        ? formatMoney(field.price.minor, field.price.currency, locale)
        : null;
      // Shares × a public price is the trade value: privacy mode masks the count as well.
      const shares = (count: number) => (hidden ? t('sharesMasked') : t('shares', { count }));
      const value =
        field.shares !== undefined && price
          ? t('instrumentValue', {
              ticker: field.ticker,
              shares: shares(field.shares),
              price,
            })
          : [field.ticker, field.shares !== undefined ? shares(field.shares) : price]
              .filter(Boolean)
              .join(' · ');
      return <Row label={label}>{value}</Row>;
    }
    case 'location':
      return (
        <Row label={label}>
          {field.city && field.country
            ? t('locationValue', { city: field.city, country: field.country })
            : (field.city ?? field.country)}
        </Row>
      );
    case 'mcc':
      return (
        <Row label={label}>
          {field.label
            ? t('mccValue', { label: field.label, code: field.code })
            : `MCC ${field.code}`}
        </Row>
      );
    case 'remittance':
      return (
        <Row label={label}>
          {field.lines.map((line, i) => (
            <span key={i} className="block select-text break-words">
              {line}
            </span>
          ))}
        </Row>
      );
    case 'balanceAfter':
      return (
        <Row label={label}>
          <MoneyAmount minor={field.amount} currency={field.currency} kind="balance" />
        </Row>
      );
    case 'original':
      return (
        <Row label={label}>
          <span className="select-text break-words">{field.value}</span>
        </Row>
      );
    case 'source':
      return (
        <Row label={label}>
          {field.source === 'import'
            ? t('source.import')
            : field.source === 'manual'
              ? t('source.manual')
              : t('source.connector')}
        </Row>
      );
    default:
      return (
        <Row label={label}>
          <span className="select-text break-words">{field.value}</span>
        </Row>
      );
  }
}
