'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition, type FormEvent } from 'react';
import { parseAmount } from '@arfolio/core';
import { createAccountAction, updateAccountAction } from '@/server/actions/accounts';
import type { AccountDto } from '@/server/serialize';
import { ACCOUNT_TYPES, TYPE_ICONS } from './type-icons';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Field, Input } from '../ui/field';
import { Select } from '../ui/select';
import { Sheet } from '../ui/sheet';
import { Switch } from '../ui/switch';
import { useToast } from '../ui/toast';
import { useFailureMessage } from '../use-action-error';

export { ACCOUNT_TYPES };

/** Minor units as an editable decimal string ("1234.50"), without grouping. */
function toInput(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Add or edit an account. The currency is fixed once the account exists. */
export function AccountFormSheet({
  open,
  onOpenChange,
  account,
  currencies,
  defaultCurrency,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account?: AccountDto;
  currencies: Array<{ value: string; label: string }>;
  defaultCurrency: string;
  onSaved: (account: AccountDto) => void;
}) {
  const t = useTranslations('accounts');
  const types = useTranslations('accounts.types');
  const toast = useToast();
  const failure = useFailureMessage();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountDto['type']>('checking');
  const [institution, setInstitution] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [opening, setOpening] = useState('');
  const [openingDate, setOpeningDate] = useState('');
  const [creditLimit, setCreditLimit] = useState('');
  const [inBudget, setInBudget] = useState(true);
  const [inNetWorth, setInNetWorth] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setName(account?.name ?? '');
    setType(account?.type ?? 'checking');
    setInstitution(account?.institutionName ?? '');
    setCurrency(account?.currency ?? defaultCurrency);
    setOpening(account && account.openingBalance !== 0 ? toInput(account.openingBalance) : '');
    setOpeningDate(account?.openingBalanceDate ?? '');
    setCreditLimit(account?.creditLimit != null ? toInput(account.creditLimit) : '');
    setInBudget(account?.includeInBudget ?? true);
    setInNetWorth(account?.includeInNetWorth ?? true);
    setError(null);
    setFieldErrors({});
  }, [open, account, defaultCurrency]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = t('nameRequired');
    let openingMinor = 0;
    if (opening.trim()) {
      try {
        openingMinor = parseAmount(opening);
      } catch {
        errors.opening = t('openingInvalid');
      }
    }
    if (openingMinor !== 0 && !openingDate) errors.openingDate = t('openingDateRequired');
    let creditLimitMinor: number | null = null;
    if (type === 'card' && creditLimit.trim()) {
      try {
        creditLimitMinor = parseAmount(creditLimit);
        if (creditLimitMinor < 0) errors.creditLimit = t('creditLimitInvalid');
      } catch {
        errors.creditLimit = t('creditLimitInvalid');
      }
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const body = {
      name,
      type,
      institutionName: institution.trim() || null,
      openingBalance: openingMinor,
      openingBalanceDate: openingDate || null,
      includeInBudget: inBudget,
      includeInNetWorth: inNetWorth,
      creditLimit: creditLimitMinor,
    };
    startTransition(async () => {
      const result = account
        ? await updateAccountAction(account.id, body)
        : await createAccountAction({ ...body, currency });
      if (!result.ok) return setError(failure(result));
      toast.success(account ? t('saved') : t('created'));
      onOpenChange(false);
      onSaved(result.data);
    });
  }

  const nameId = 'account-switch-budget';
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={account ? t('editTitle') : t('addTitle')}
      tall
    >
      <form method="post" onSubmit={submit} className="grid grid-cols-1 gap-4" noValidate>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field label={t('name')} error={fieldErrors.name}>
          {(p) => (
            <Input
              {...p}
              value={name}
              maxLength={120}
              required
              autoComplete="off"
              onChange={(e) => {
                setName(e.target.value);
                setFieldErrors((cur) => ({ ...cur, name: '' }));
              }}
            />
          )}
        </Field>

        <fieldset className="grid grid-cols-1 gap-1.5">
          <legend className="text-sm font-medium">{t('type')}</legend>
          <div className="grid grid-cols-2 gap-2">
            {ACCOUNT_TYPES.map((value) => {
              const Icon = TYPE_ICONS[value];
              return (
                <label
                  key={value}
                  className="flex min-h-12 cursor-pointer items-center gap-2 rounded-lg border border-input px-3 has-[:checked]:border-primary has-[:checked]:bg-primary-soft has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring"
                >
                  <input
                    type="radio"
                    name="type"
                    value={value}
                    checked={type === value}
                    onChange={() => setType(value)}
                    className="sr-only"
                  />
                  <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="text-base">{types(value)}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <Field label={t('institution')} hint={t('optional')}>
          {(p) => (
            <Input
              {...p}
              value={institution}
              maxLength={120}
              autoComplete="off"
              onChange={(e) => setInstitution(e.target.value)}
            />
          )}
        </Field>

        <Field label={t('currency')} hint={account ? t('currencyFixed') : undefined}>
          {(p) => (
            <Select
              {...p}
              value={currency}
              disabled={account !== undefined}
              onChange={(e) => setCurrency(e.target.value)}
            >
              {currencies.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        {type === 'card' ? (
          <Field
            label={t('creditLimit')}
            error={fieldErrors.creditLimit}
            hint={`${t('optional')}. ${t('creditLimitHint')}`}
          >
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                autoComplete="off"
                value={creditLimit}
                className="tabular-nums"
                onChange={(e) => {
                  setCreditLimit(e.target.value);
                  setFieldErrors((cur) => ({ ...cur, creditLimit: '' }));
                }}
              />
            )}
          </Field>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('opening')} error={fieldErrors.opening} hint={t('optional')}>
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                autoComplete="off"
                value={opening}
                className="tabular-nums"
                onChange={(e) => setOpening(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('openingDate')} error={fieldErrors.openingDate}>
            {(p) => (
              <Input
                {...p}
                type="date"
                value={openingDate}
                onChange={(e) => setOpeningDate(e.target.value)}
              />
            )}
          </Field>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg bg-surface shadow-card p-3 pl-4">
          <p id={nameId} className="text-base">
            {t('includeInBudget')}
          </p>
          <Switch checked={inBudget} onCheckedChange={setInBudget} aria-labelledby={nameId} />
        </div>
        <div className="flex items-center justify-between gap-4 rounded-lg bg-surface shadow-card p-3 pl-4">
          <p id="account-switch-networth" className="text-base">
            {t('includeInNetWorth')}
          </p>
          <Switch
            checked={inNetWorth}
            onCheckedChange={setInNetWorth}
            aria-labelledby="account-switch-networth"
          />
        </div>

        <Button type="submit" loading={pending}>
          {t('save')}
        </Button>
      </form>
    </Sheet>
  );
}
