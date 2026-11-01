'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';
import { formatMonthTitle } from '@/lib/net-worth-format';
import { recalculateNetWorthAction } from '@/server/actions/net-worth';
import { useHouseholdFormat } from '../household-format';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Field } from '../ui/field';
import { Select } from '../ui/select';
import { Sheet } from '../ui/sheet';
import { useToast } from '../ui/toast';
import { useFailureMessage } from '../use-action-error';

/** "Recalcular um mês": stores the net worth of a past month again from today's data. */
export function RecalculateSheet({
  open,
  onOpenChange,
  months,
  defaultMonth,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Past months (`yyyy-mm-01`), newest first. */
  months: string[];
  defaultMonth: string;
}) {
  const t = useTranslations('netWorth');
  const router = useRouter();
  const toast = useToast();
  const failure = useFailureMessage();
  const { locale } = useHouseholdFormat();
  const [month, setMonth] = useState(defaultMonth);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const formId = useId();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const result = await recalculateNetWorthAction(month);
      if (!result.ok) {
        setError(failure(result));
        return;
      }
      toast.success(
        t('recalcDone', { month: formatMonthTitle(month, locale).toLocaleLowerCase(locale) }),
      );
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('recalcTitle')}
      description={t('recalcBody')}
      footer={
        <Button type="submit" form={formId} loading={pending} className="w-full md:w-auto">
          {pending ? t('recalcRunning') : t('recalcAction')}
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
        {error ? <Alert tone="error">{error}</Alert> : null}
        <Field label={t('recalcMonth')}>
          {(p) => (
            <Select {...p} value={month} onChange={(e) => setMonth(e.target.value)}>
              {months.map((m) => (
                <option key={m} value={m}>
                  {formatMonthTitle(m, locale)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </form>
    </Sheet>
  );
}
