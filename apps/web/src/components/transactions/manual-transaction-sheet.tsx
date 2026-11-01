'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition, type FormEvent } from 'react';
import { parseAmount } from '@arfolio/core';
import { createManualTransactionAction } from '@/server/actions/transactions';
import type { AccountDto, GroupDto } from '@/server/serialize';
import { CategoryChip } from '../category-icon';
import { CategoryPicker } from '../category-picker';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Field, Input } from '../ui/field';
import { Select } from '../ui/select';
import { Sheet } from '../ui/sheet';
import { Textarea } from '../ui/textarea';
import { useToast } from '../ui/toast';
import { useFailureMessage } from '../use-action-error';
import { ADD_TRIGGER_ID } from './add-menu';

/** Adds one movement by hand: account, date, direction and amount, description, optional extras. */
export function ManualTransactionSheet({
  open,
  onOpenChange,
  accounts,
  groups,
  today,
  defaultAccountId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: AccountDto[];
  groups: GroupDto[];
  today: string;
  defaultAccountId?: string;
  onCreated: () => void;
}) {
  const t = useTranslations('manual');
  const toast = useToast();
  const failure = useFailureMessage();
  const [pending, startTransition] = useTransition();
  const [accountId, setAccountId] = useState(defaultAccountId ?? accounts[0]?.id ?? '');
  const [date, setDate] = useState(today);
  const [direction, setDirection] = useState<'out' | 'in'>('out');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [counterparty, setCounterparty] = useState('');
  const [notes, setNotes] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState(false);

  // Start from a clean form each time the sheet opens, and only then: the parent passes a fresh
  // `accounts` array on every render, so resetting on prop changes would wipe what is being typed.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setAccountId(defaultAccountId ?? accounts[0]?.id ?? '');
      setDate(today);
      setDirection('out');
      setAmount('');
      setDescription('');
      setCounterparty('');
      setNotes('');
      setCategoryId(null);
      setError(null);
      setAmountError(false);
    }
  }

  const categories = groups.flatMap((g) => g.categories);
  const category = categories.find((c) => c.id === categoryId);

  function submit(e: FormEvent) {
    e.preventDefault();
    let minor: number;
    try {
      minor = parseAmount(amount);
    } catch {
      setAmountError(true);
      return;
    }
    if (minor === 0) {
      setAmountError(true);
      return;
    }
    setAmountError(false);
    startTransition(async () => {
      const result = await createManualTransactionAction({
        accountId,
        bookingDate: date,
        amount: direction === 'out' ? -Math.abs(minor) : Math.abs(minor),
        description,
        ...(counterparty.trim() ? { counterparty } : {}),
        ...(notes.trim() ? { notes } : {}),
        ...(categoryId ? { categoryId } : {}),
      });
      if (!result.ok) return setError(failure(result));
      toast.success(t('created'));
      onOpenChange(false);
      onCreated();
    });
  }

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={onOpenChange}
        title={t('title')}
        tall
        onCloseAutoFocus={(e) => {
          // Opened from the header's "Adicionar" menu, which has no Trigger tied to this sheet.
          const target = document.getElementById(ADD_TRIGGER_ID);
          if (target) {
            e.preventDefault();
            target.focus();
          }
        }}
      >
        <form method="post" onSubmit={submit} className="grid grid-cols-1 gap-4" noValidate>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Field label={t('account')}>
            {(p) => (
              <Select
                {...p}
                value={accountId}
                required
                onChange={(e) => setAccountId(e.target.value)}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <fieldset className="grid grid-cols-1 gap-1.5">
            <legend className="text-sm font-medium">{t('direction')}</legend>
            <div className="grid grid-cols-2 gap-2">
              {(['out', 'in'] as const).map((d) => (
                <label
                  key={d}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-input px-3 has-[:checked]:border-primary has-[:checked]:bg-primary-soft"
                >
                  <input
                    type="radio"
                    name="direction"
                    checked={direction === d}
                    onChange={() => setDirection(d)}
                    className="size-5 accent-[var(--primary)]"
                  />
                  <span className="text-base">{t(d)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <Field label={t('amount')} error={amountError ? t('amountInvalid') : undefined}>
            {(p) => (
              <Input
                {...p}
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                required
                className="tabular-nums"
                onChange={(e) => setAmount(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('date')}>
            {(p) => (
              <Input
                {...p}
                type="date"
                value={date}
                required
                onChange={(e) => setDate(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('description')}>
            {(p) => (
              <Input
                {...p}
                value={description}
                maxLength={500}
                required
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('counterparty')} hint={t('optional')}>
            {(p) => (
              <Input
                {...p}
                value={counterparty}
                maxLength={200}
                onChange={(e) => setCounterparty(e.target.value)}
              />
            )}
          </Field>
          <div className="grid grid-cols-1 gap-1.5">
            <span className="text-sm font-medium">{t('category')}</span>
            <div className="flex items-center gap-2">
              <CategoryChip
                category={category}
                uncategorisedLabel={t('categoryNone')}
                large
                onClick={() => setPickerOpen(true)}
              />
              {categoryId ? (
                <Button type="button" variant="ghost" onClick={() => setCategoryId(null)}>
                  {t('categoryClear')}
                </Button>
              ) : null}
            </div>
          </div>
          <Field label={t('notes')} hint={t('optional')}>
            {(p) => (
              <Textarea
                {...p}
                value={notes}
                maxLength={2000}
                onChange={(e) => setNotes(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" loading={pending} disabled={!accountId || !description.trim()}>
            {t('save')}
          </Button>
        </form>
      </Sheet>
      <CategoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        groups={groups}
        selectedId={categoryId}
        showMerchantOptions={false}
        onPick={(id) => {
          setCategoryId(id);
          setPickerOpen(false);
        }}
      />
    </>
  );
}
