'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, useTransition } from 'react';
import { parsePlanned } from '@/lib/amount-input';
import { isIsoDate } from '@/lib/dates';
import { formatDayYear } from '@/lib/net-worth-format';
import { addAssetValuationAction, addLiabilityBalanceAction } from '@/server/actions/net-worth';
import { useHouseholdFormat } from '../household-format';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Field, Input } from '../ui/field';
import { Sheet } from '../ui/sheet';
import { useToast } from '../ui/toast';
import { useFailureMessage } from '../use-action-error';

/**
 * "Atualizar valor" / "Atualizar saldo": date, amount and an optional note. A second value for a
 * day replaces the first (the service's rule), and the sheet says so before it happens.
 */
export function ValuationSheet({
  mode,
  recordId,
  today,
  existingDates,
  open,
  onOpenChange,
}: {
  mode: 'asset' | 'liability';
  recordId: string;
  today: string;
  /** Days that already hold a value or balance. */
  existingDates: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations(mode);
  const common = useTranslations('common');
  const router = useRouter();
  const toast = useToast();
  const failure = useFailureMessage();
  const { locale } = useHouseholdFormat();
  const formId = useId();
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<{ date?: string; amount?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // A sheet that opens again starts clean: today's date, no old errors.
  useEffect(() => {
    if (!open) return;
    setDate(today);
    setAmount('');
    setNote('');
    setErrors({});
    setFormError(null);
  }, [open, today]);

  const replaces = isIsoDate(date) && existingDates.includes(date);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const found: { date?: string; amount?: string } = {};
    if (!date) found.date = t('form.dateRequired');
    else if (!isIsoDate(date)) found.date = t('form.dateInvalid');
    const parsed = parsePlanned(amount);
    if (amount.trim() === '') found.amount = t('form.valueRequired');
    else if (!parsed.ok) found.amount = t('form.valueInvalid');
    setErrors(found);
    if (found.date || found.amount || !parsed.ok) return;
    start(async () => {
      const input = { asOf: date, amount: parsed.minor, note: note.trim() || null };
      const result =
        mode === 'asset'
          ? await addAssetValuationAction(recordId, input)
          : await addLiabilityBalanceAction(recordId, input);
      if (!result.ok) {
        setFormError(failure(result));
        return;
      }
      toast.success(t('form.valueSaved'));
      setAmount('');
      setNote('');
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('update')}
      footer={
        <Button type="submit" form={formId} loading={pending} className="w-full md:w-auto">
          {pending ? common('saving') : common('save')}
        </Button>
      }
    >
      <form
        method="post"
        id={formId}
        onSubmit={submit}
        noValidate
        className="grid grid-cols-1 gap-4 pt-2"
      >
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <Field
          label={t('form.date')}
          hint={
            replaces
              ? t('form.replaces', { date: formatDayYear(date, locale) })
              : t('form.dateHint')
          }
          error={errors.date}
        >
          {(p) => (
            <Input
              {...p}
              type="date"
              name="asOf"
              value={date}
              required
              onChange={(e) => setDate(e.target.value)}
            />
          )}
        </Field>
        <Field label={t('form.value')} error={errors.amount}>
          {(p) => (
            <Input
              {...p}
              name="amount"
              inputMode="decimal"
              autoComplete="off"
              autoFocus
              value={amount}
              className="text-right tabular-nums"
              onChange={(e) => setAmount(e.target.value)}
            />
          )}
        </Field>
        <Field label={t('form.note')}>
          {(p) => (
            <Input
              {...p}
              name="note"
              maxLength={500}
              autoComplete="off"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          )}
        </Field>
      </form>
    </Sheet>
  );
}
