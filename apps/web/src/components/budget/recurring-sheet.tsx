'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState, useTransition, type FormEvent } from 'react';
import { parsePlanned, toPlannedInput } from '@/lib/amount-input';
import { truncateName } from '@/lib/budget-import-copy';
import type { Cadence, RecurringDto } from '@/lib/recurring-display';
import {
  declareRecurringAction,
  dismissRecurringAction,
  updateRecurringAction,
} from '@/server/actions/recurring';
import type { GroupDto } from '@/server/serialize';
import { useHouseholdFormat } from '../household-format';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Field, Input } from '../ui/field';
import { Select } from '../ui/select';
import { Sheet } from '../ui/sheet';
import { useToast } from '../ui/toast';
import { useFailureMessage } from '../use-action-error';

const CADENCES: readonly Cadence[] = ['weekly', 'monthly', 'quarterly', 'yearly'];

interface Form {
  name: string;
  direction: 'payment' | 'receipt';
  amount: string;
  cadence: Cadence;
  nextExpectedOn: string;
  accountId: string;
  categoryId: string;
  budgetLineId: string;
}

const empty: Form = {
  name: '',
  direction: 'payment',
  amount: '',
  cadence: 'monthly',
  nextExpectedOn: '',
  accountId: '',
  categoryId: '',
  budgetLineId: '',
};

/** Declare a recurring payment or edit one. Editing a detected item confirms it. */
export function RecurringSheet({
  open,
  onOpenChange,
  item,
  accounts,
  groups,
  lines,
  onSaved,
  onDismissed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null to declare a new one. */
  item: RecurringDto | null;
  accounts: Array<{ id: string; name: string; archived: boolean }>;
  groups: GroupDto[];
  lines: Array<{ id: string; name: string }>;
  onSaved: (item: RecurringDto) => void;
  onDismissed: (item: RecurringDto) => void;
}) {
  const t = useTranslations('recurring.form');
  const cadences = useTranslations('recurring.cadence');
  const common = useTranslations('common');
  const toast = useToast();
  const failure = useFailureMessage();
  const { locale } = useHouseholdFormat();
  const [form, setForm] = useState<Form>(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [dismissing, startDismiss] = useTransition();
  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setError(null);
    setForm(
      item
        ? {
            name: item.name,
            direction: item.amount > 0 ? 'receipt' : 'payment',
            amount: toPlannedInput(Math.abs(item.amount), locale),
            cadence: item.cadence,
            nextExpectedOn: item.nextExpectedOn ?? '',
            accountId: item.accountId ?? '',
            categoryId: item.categoryId ?? '',
            budgetLineId: item.budgetLineId ?? '',
          }
        : empty,
    );
  }, [open, item, locale]);

  const confirming = item?.status === 'detected';

  function submit(e: FormEvent) {
    e.preventDefault();
    const found: Record<string, string> = {};
    if (!form.name.trim()) found.name = t('nameRequired');
    const amount = parsePlanned(form.amount);
    if (!amount.ok || amount.minor === 0) {
      found.amount =
        !amount.ok && amount.reason === 'negative' ? t('amountNegative') : t('amountInvalid');
    }
    setErrors(found);
    if (Object.keys(found).length > 0 || !amount.ok) return;
    const signed = form.direction === 'payment' ? -amount.minor : amount.minor;
    const body = {
      name: form.name.trim(),
      amount: signed,
      cadence: form.cadence,
      nextExpectedOn: form.nextExpectedOn || null,
      accountId: form.accountId || null,
      categoryId: form.categoryId || null,
      budgetLineId: form.budgetLineId || null,
    };
    setError(null);
    startTransition(async () => {
      const result = item
        ? await updateRecurringAction(item.id, body)
        : await declareRecurringAction(body);
      if (!result.ok) return setError(failure(result));
      toast.success(item ? (confirming ? t('confirmedSaved') : t('saved')) : t('added'));
      onSaved(result.data);
      onOpenChange(false);
    });
  }

  function dismiss() {
    if (!item) return;
    startDismiss(async () => {
      const result = await dismissRecurringAction(item.id);
      if (!result.ok) return setError(failure(result));
      toast.success(t('dismissed', { name: truncateName(item.name) }));
      onDismissed(result.data);
      onOpenChange(false);
    });
  }

  const usableGroups = groups.filter((g) => !g.archived && g.kind !== 'transfer');
  const knownLine = lines.some((l) => l.id === form.budgetLineId);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={item ? t('editTitle', { name: truncateName(item.name) }) : t('addTitle')}
      tall
    >
      <form method="post" onSubmit={submit} noValidate className="grid grid-cols-1 gap-4">
        {error ? <Alert tone="error">{error}</Alert> : null}

        <Field label={t('name')} error={errors.name}>
          {(p) => (
            <Input
              {...p}
              value={form.name}
              maxLength={120}
              required
              autoComplete="off"
              onChange={(e) => set('name', e.target.value)}
            />
          )}
        </Field>

        <fieldset className="grid grid-cols-1 gap-1.5">
          <legend className="text-sm font-medium">{t('direction')}</legend>
          <div className="inline-flex w-fit rounded-lg bg-surface-2 p-1">
            {(['payment', 'receipt'] as const).map((value) => (
              <label
                key={value}
                className={`flex min-h-11 cursor-pointer items-center rounded-md px-4 text-sm font-medium has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring ${
                  form.direction === value
                    ? 'bg-surface text-foreground shadow-[var(--shadow-sm)]'
                    : 'text-muted-foreground'
                }`}
              >
                <input
                  type="radio"
                  name="direction"
                  value={value}
                  checked={form.direction === value}
                  onChange={() => set('direction', value)}
                  className="sr-only"
                />
                {t(value)}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('amount')} error={errors.amount}>
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                autoComplete="off"
                value={form.amount}
                className="text-right tabular-nums"
                onChange={(e) => set('amount', e.target.value)}
              />
            )}
          </Field>
          <Field label={t('cadence')}>
            {(p) => (
              <Select
                {...p}
                value={form.cadence}
                onChange={(e) => set('cadence', e.target.value as Cadence)}
              >
                {CADENCES.map((c) => (
                  <option key={c} value={c}>
                    {cadences(c)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <Field label={t('next')} hint={t('nextHint')}>
          {(p) => (
            <Input
              {...p}
              type="date"
              value={form.nextExpectedOn}
              onChange={(e) => set('nextExpectedOn', e.target.value)}
            />
          )}
        </Field>

        <Field label={t('account')}>
          {(p) => (
            <Select
              {...p}
              value={form.accountId}
              onChange={(e) => set('accountId', e.target.value)}
            >
              <option value="">{t('none')}</option>
              {accounts
                .filter((a) => !a.archived || a.id === form.accountId)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </Select>
          )}
        </Field>

        <Field label={t('category')}>
          {(p) => (
            <Select
              {...p}
              value={form.categoryId}
              onChange={(e) => set('categoryId', e.target.value)}
            >
              <option value="">{t('none')}</option>
              {usableGroups.map((g) => (
                <optgroup key={g.id} label={g.name}>
                  {g.categories
                    .filter((c) => !c.archived || c.id === form.categoryId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
          )}
        </Field>

        <Field label={t('line')} hint={t('lineHint')}>
          {(p) => (
            <Select
              {...p}
              value={form.budgetLineId}
              onChange={(e) => set('budgetLineId', e.target.value)}
            >
              <option value="">{t('none')}</option>
              {form.budgetLineId && !knownLine ? (
                <option value={form.budgetLineId}>{t('otherLine')}</option>
              ) : null}
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {truncateName(l.name, 60)}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          {item ? (
            <Button
              variant="ghost"
              loading={dismissing}
              className="text-negative hover:bg-negative-soft"
              onClick={dismiss}
            >
              {t('dismiss')}
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit" loading={pending}>
            {confirming ? t('saveConfirm') : common('save')}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
