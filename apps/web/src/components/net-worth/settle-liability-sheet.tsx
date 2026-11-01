'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from 'react';
import { isIsoDate } from '@/lib/dates';
import { settleLiabilityAction } from '@/server/actions/net-worth';
import { useHouseholdFormat } from '../household-format';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Field, Input } from '../ui/field';
import { Sheet } from '../ui/sheet';
import { useToast } from '../ui/toast';
import { useFailureMessage } from '../use-action-error';
import { useFormatMoney } from '@/components/privacy';

/** "Liquidar": the liability stops counting from a date (not in the future); its history stays. */
export function SettleLiabilitySheet({
  open,
  onOpenChange,
  liability,
  today,
  existingDates,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  liability: { id: string; name: string; currency: string; accountName: string | null };
  today: string;
  /** Days that already hold a balance (no zero is added on them). */
  existingDates: string[];
  /** Called once the change is saved, before the page refreshes. */
  onDone: () => void;
}) {
  const t = useTranslations('settlement');
  const router = useRouter();
  const toast = useToast();
  const failure = useFailureMessage();
  const { locale } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const formId = useId();
  const [date, setDate] = useState(today);
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const saved = useRef(false);

  // A sheet that opens again starts clean.
  useEffect(() => {
    if (!open) return;
    setDate(today);
    setError(undefined);
    setFormError(null);
    saved.current = false;
  }, [open, today]);

  const dates = useTranslations('disposal');
  const problem = (value: string): string | undefined => {
    if (!value) return dates('dateRequired');
    if (!isIsoDate(value)) return dates('dateInvalid');
    if (value > today) return dates('dateFuture');
    return undefined;
  };

  const hint = liability.accountName
    ? t('hintAccount', { account: liability.accountName })
    : isIsoDate(date) && existingDates.includes(date)
      ? undefined
      : t('hintBalance', { zero: formatMoney(0, liability.currency, locale) });

  function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const found = problem(date);
    setError(found);
    if (found) return;
    start(async () => {
      const result = await settleLiabilityAction(liability.id, { date });
      if (!result.ok) {
        const code = result.code === 'validation' ? result.detail?.code : undefined;
        if (code === 'date_in_future') setError(failure(result));
        else setFormError(failure(result));
        return;
      }
      saved.current = true;
      toast.success(t('done'));
      onOpenChange(false);
      onDone();
      router.refresh();
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
      title={t('title', { name: liability.name })}
      description={t('description')}
      onCloseAutoFocus={(event) => {
        // The button that opened this is gone once the page changes state: the page moves focus.
        if (saved.current) event.preventDefault();
      }}
      footer={
        <Button type="submit" form={formId} loading={pending} className="w-full md:w-auto">
          {pending ? t('submitting') : t('submit')}
        </Button>
      }
    >
      <form method="post" id={formId} onSubmit={submit} noValidate className="grid gap-4 pt-2">
        {formError ? <Alert tone="error">{formError}</Alert> : null}
        <Field label={t('date')} hint={hint} error={error}>
          {(p) => (
            <Input
              {...p}
              type="date"
              name="date"
              value={date}
              max={today}
              required
              autoFocus
              onChange={(e) => {
                setDate(e.target.value);
                setError(undefined);
              }}
            />
          )}
        </Field>
      </form>
    </Sheet>
  );
}
