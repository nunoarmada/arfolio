'use client';

import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { useFailureMessage } from '@/components/use-action-error';
import { useLeaveGuard } from '@/components/use-leave-guard';
import { cn } from '@/lib/cn';
import type { Option } from '@/lib/format';
import {
  saveBudgetSettingsAction,
  type BudgetSettingsInput,
} from '@/server/actions/budget-settings';

/** Percentages offered as chips; any other stored value is shown too. At most five can be set. */
const STANDARD = [50, 75, 80, 90, 100, 120];
const MAX_THRESHOLDS = 5;

export function BudgetSettingsForm({
  initial,
  canEdit,
  months,
  accounts,
}: {
  initial: BudgetSettingsInput;
  canEdit: boolean;
  months: Option[];
  accounts: Array<{ id: string; name: string; archived: boolean }>;
}) {
  const t = useTranslations('budgetSettings');
  const common = useTranslations('common');
  const toast = useToast();
  const router = useRouter();
  const failure = useFailureMessage();
  const [saved, setSaved] = useState(initial);
  const [values, setValues] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dirty = JSON.stringify(values) !== JSON.stringify(saved);
  const { dialog } = useLeaveGuard(dirty);
  const readOnly = !canEdit;

  const chips = [...new Set([...STANDARD, ...values.thresholds])].sort((a, b) => a - b);
  const chosen = new Set(values.thresholds);
  const full = chosen.size >= MAX_THRESHOLDS;

  function toggle(value: number) {
    setValues((v) => {
      const next = new Set(v.thresholds);
      if (next.has(value)) next.delete(value);
      else if (next.size < MAX_THRESHOLDS) next.add(value);
      return { ...v, thresholds: [...next].sort((a, b) => a - b) };
    });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await saveBudgetSettingsAction(values);
      if (!result.ok) return setError(failure(result));
      toast.success(t('saved'));
      setSaved(values);
      router.refresh();
    });
  }

  return (
    <form method="post" onSubmit={submit} className="grid grid-cols-1 gap-6">
      {dialog}
      {readOnly ? <Alert tone="info">{t('readOnly')}</Alert> : null}
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card pad="md" className="grid grid-cols-1 gap-5">
        <Field label={t('fiscal')} hint={t('fiscalHint')}>
          {(p) => (
            <Select
              {...p}
              value={String(values.fiscalYearStartMonth)}
              disabled={readOnly}
              onChange={(e) =>
                setValues((v) => ({ ...v, fiscalYearStartMonth: Number(e.target.value) }))
              }
            >
              {months.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div id="hub" className="scroll-mt-24">
          <Field label={t('hub')} hint={t('hubHint')}>
            {(p) => (
              <Select
                {...p}
                value={values.hubAccountId ?? ''}
                disabled={readOnly}
                onChange={(e) => setValues((v) => ({ ...v, hubAccountId: e.target.value || null }))}
              >
                <option value="">{t('none')}</option>
                {accounts
                  .filter((a) => !a.archived || a.id === values.hubAccountId)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        </div>
      </Card>

      <Card pad="md">
        <fieldset className="grid grid-cols-1 gap-2" aria-describedby="alerts-help">
          <legend className="text-card-title mb-1">{t('alertsLegend')}</legend>
          <div className="flex flex-wrap gap-2">
            {chips.map((value) => {
              const on = chosen.has(value);
              const blocked = !on && (full || readOnly);
              return (
                <label
                  key={value}
                  className={cn(
                    'inline-flex min-h-11 items-center gap-1.5 rounded-md border px-4 text-base font-medium lg:pointer-fine:min-h-9 lg:pointer-fine:text-sm has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
                    on ? 'border-primary bg-primary-soft' : 'border-input bg-surface',
                    blocked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-surface-2',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={readOnly}
                    aria-disabled={blocked || undefined}
                    onChange={() => toggle(value)}
                    className="sr-only"
                  />
                  {on ? <Check className="size-4 text-primary" aria-hidden="true" /> : null}
                  {value}%
                </label>
              );
            })}
          </div>
          {/* Always mounted, so assistive technology announces what appears in it. */}
          <div aria-live="polite" className="empty:-mt-2">
            {values.thresholds.length === 0 || full ? (
              <p
                className={cn(
                  'text-sm',
                  values.thresholds.length === 0 && 'font-medium text-foreground',
                )}
              >
                {values.thresholds.length === 0
                  ? t('alertsOff')
                  : t('alertsMax', { max: MAX_THRESHOLDS })}
              </p>
            ) : null}
          </div>
          <p id="alerts-help" className="text-sm text-muted-foreground">
            {t('alertsHelp')}
          </p>
          <p className="text-sm text-muted-foreground">{t('alertsTransfer')}</p>
        </fieldset>
      </Card>

      {canEdit ? (
        <div
          className={cn(
            'sticky bottom-[calc(var(--tabbar-height)+env(safe-area-inset-bottom))] z-10 -mx-4 flex items-center justify-between gap-3 border-t border-border bg-surface/90 px-4 py-3 backdrop-blur-md md:static md:mx-0 md:border-0 md:bg-transparent md:px-0 md:py-0 md:backdrop-blur-none',
            !dirty && 'hidden md:flex',
          )}
        >
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {dirty ? t('dirty') : ''}
          </p>
          <Button type="submit" loading={pending} disabled={!dirty}>
            {pending ? common('saving') : common('save')}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
