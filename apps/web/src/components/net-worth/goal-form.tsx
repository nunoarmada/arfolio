'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition, type FormEvent } from 'react';
import { toPlannedInput } from '@/lib/amount-input';
import { cn } from '@/lib/cn';
import { parseGoalForm, type GoalFormError, type GoalFormValues } from '@/lib/goals';
import { createGoalAction, updateGoalAction } from '@/server/actions/goals';
import type { GoalFormData } from '@/server/goals-data';
import { useHouseholdFormat } from '../household-format';
import { Alert } from '../ui/alert';
import { buttonVariants } from '../ui/button';
import { Field, Input } from '../ui/field';
import { Select } from '../ui/select';
import { useToast } from '../ui/toast';
import { useFailureMessage } from '../use-action-error';
import { useLeaveGuard } from '../use-leave-guard';
import { ErrorSummary, FormCard, RadioCard, SaveBar } from './form-parts';
import { useFormatMoney } from '@/components/privacy';

/** A minor-unit amount as typed text: not set is empty, a real zero stays "0". */
function amountText(minor: number | null, locale: string): string {
  if (minor === null) return '';
  return minor === 0 ? '0' : toPlannedInput(minor, locale);
}

/** Add or change a goal: what it is, its target, where the money is and what goes in each month. */
export function GoalForm({
  data,
  defaultKind,
  isOwner,
  back,
}: {
  data: GoalFormData;
  defaultKind: string;
  isOwner: boolean;
  back: string;
}) {
  const t = useTranslations('goals.form');
  const common = useTranslations('common');
  const router = useRouter();
  const toast = useToast();
  const failure = useFailureMessage();
  const { locale, currency } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const money = (minor: number) => formatMoney(minor, currency, locale);
  const editing = data.goal;

  const initial: GoalFormValues = useMemo(
    () => ({
      kind:
        editing?.kind ??
        (defaultKind === 'emergency_fund' && !data.otherEmergencyFund
          ? 'emergency_fund'
          : 'generic'),
      name: editing?.name ?? '',
      target: amountText(editing?.targetAmount ?? null, locale),
      targetDate: editing?.targetDate ?? '',
      where: editing?.accountId ? 'account' : editing?.budgetLineId ? 'line' : 'none',
      accountId: editing?.accountId ?? '',
      lineId: editing?.budgetLineId ?? '',
      contribution: amountText(editing?.monthlyContribution ?? null, locale),
      alreadySaved: amountText(editing?.savedBaseline ?? null, locale),
      alreadySavedDate: editing?.savedBaselineDate ?? '',
    }),
    [editing, defaultKind, data.otherEmergencyFund, locale],
  );
  const [values, setValues] = useState<GoalFormValues>(initial);
  const [saved, setSaved] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof GoalFormValues, GoalFormError>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const dirty = !saved && JSON.stringify(values) !== JSON.stringify(initial);
  const { dialog, leave } = useLeaveGuard(dirty);

  const set = <K extends keyof GoalFormValues>(key: K, value: GoalFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };
  const emergency = values.kind === 'emergency_fund';
  // A second emergency fund is not offered; an existing one can still be turned back into a goal.
  const offerKind = !data.otherEmergencyFund;
  const selectedLine = data.savingLines.find((l) => l.id === values.lineId);
  const labels: Record<string, string> = {
    name: t('name'),
    target: t('target'),
    targetDate: t('targetDate'),
    accountId: t('account'),
    lineId: t('line'),
    contribution: t('contribution'),
    alreadySaved: t('alreadySaved'),
    alreadySavedDate: t('alreadySavedDate'),
  };
  const errorText = (field: keyof GoalFormValues): string | undefined => {
    const code = errors[field];
    return code ? t(`error.${code}`) : undefined;
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setFormError(null);
    const parsed = parseGoalForm(values, initial);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors({});
    start(async () => {
      const result = editing
        ? await updateGoalAction(editing.id, parsed.input)
        : await createGoalAction(parsed.input);
      if (!result.ok) {
        const exists =
          result.code === 'validation' && result.detail?.code === 'emergency_fund_exists';
        setFormError(exists ? t('emergencyExists') : failure(result));
        return;
      }
      setSaved(true);
      toast.success(editing ? t('saved') : t('created'));
      router.push('/net-worth/goals');
    });
  }

  const messages = (Object.keys(errors) as Array<keyof GoalFormValues>)
    .filter((field) => errors[field])
    .map((field) => ({ field, label: labels[field] ?? field, message: errorText(field) ?? '' }));

  return (
    <form
      method="post"
      onSubmit={submit}
      noValidate
      className="grid grid-cols-1 max-w-[640px] gap-5"
    >
      {dialog}
      {submitted && messages.length > 0 ? (
        <ErrorSummary title={t('summary', { count: messages.length })} items={messages} />
      ) : null}
      {formError ? <Alert tone="error">{formError}</Alert> : null}

      {offerKind ? (
        <FormCard legend={t('kind')}>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {(
              [
                ['generic', t('kindGeneric')],
                ['emergency_fund', t('kindEmergency')],
              ] as const
            ).map(([value, label]) => (
              <RadioCard
                key={value}
                name="kind"
                value={value}
                checked={values.kind === value}
                onChange={() => set('kind', value)}
              >
                {label}
              </RadioCard>
            ))}
          </div>
        </FormCard>
      ) : null}

      <FormCard legend={t('sectionGoal')}>
        <Field label={t('name')} error={errorText('name')}>
          {(p) => (
            <Input
              {...p}
              name="name"
              value={values.name}
              maxLength={120}
              required
              autoComplete="off"
              onChange={(e) => set('name', e.target.value)}
            />
          )}
        </Field>

        {emergency ? (
          <div className="grid grid-cols-1 gap-1.5 rounded-lg border bg-surface-2 p-4">
            <p className="text-sm font-medium">{t('target')}</p>
            <p className="max-w-[68ch] text-base">
              {data.emergency.average !== null
                ? t('derived', {
                    avg: money(data.emergency.average),
                    months: data.emergency.months,
                    target: money(data.emergency.average * data.emergency.months),
                  })
                : t('derivedPending', { months: data.emergency.months })}
            </p>
            {isOwner ? (
              <Link
                href="/settings/household#emergency-fund"
                className={cn(buttonVariants({ variant: 'link' }), 'justify-self-start px-0')}
              >
                {t('emergencyChange')}
              </Link>
            ) : (
              <p className="text-sm text-muted-foreground">{t('emergencySetBy')}</p>
            )}
          </div>
        ) : (
          <Field label={t('target')} hint={t('targetHint')} error={errorText('target')}>
            {(p) => (
              <Input
                {...p}
                name="target"
                inputMode="decimal"
                autoComplete="off"
                value={values.target}
                className="text-right tabular-nums"
                onChange={(e) => set('target', e.target.value)}
              />
            )}
          </Field>
        )}

        <Field label={t('targetDate')} error={errorText('targetDate')}>
          {(p) => (
            <Input
              {...p}
              type="date"
              name="targetDate"
              value={values.targetDate}
              onChange={(e) => set('targetDate', e.target.value)}
            />
          )}
        </Field>
      </FormCard>

      <FormCard legend={t('where')}>
        <div className="grid grid-cols-1 gap-1">
          {(
            [
              ['account', t('whereAccount')],
              ['line', t('whereLine')],
              ['none', t('whereNone')],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              className="flex min-h-11 cursor-pointer items-center gap-3 text-base"
            >
              <input
                type="radio"
                name="where"
                value={value}
                checked={values.where === value}
                onChange={() => set('where', value)}
                className="size-5 shrink-0 cursor-pointer accent-[var(--primary)]"
              />
              {label}
            </label>
          ))}
        </div>

        {values.where === 'account' ? (
          <Field label={t('account')} error={errorText('accountId')}>
            {(p) => (
              <Select
                {...p}
                name="accountId"
                value={values.accountId}
                onChange={(e) => set('accountId', e.target.value)}
              >
                <option value="">{t('choose')}</option>
                {data.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}

        {values.where === 'line' ? (
          <Field
            label={t('line')}
            hint={data.savingLines.length === 0 ? t('noSavingLines') : undefined}
            error={errorText('lineId')}
          >
            {(p) => (
              <Select
                {...p}
                name="lineId"
                value={values.lineId}
                disabled={data.savingLines.length === 0}
                onChange={(e) => set('lineId', e.target.value)}
              >
                <option value="">{t('choose')}</option>
                {data.savingLines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
      </FormCard>

      <FormCard legend={t('sectionSaving')}>
        <Field
          label={t('contribution')}
          hint={
            values.where === 'line' && selectedLine
              ? t('contributionHint', { planned: money(selectedLine.planned) })
              : undefined
          }
          error={errorText('contribution')}
        >
          {(p) => (
            <Input
              {...p}
              name="contribution"
              inputMode="decimal"
              autoComplete="off"
              value={values.contribution}
              className="text-right tabular-nums"
              onChange={(e) => set('contribution', e.target.value)}
            />
          )}
        </Field>

        {values.where !== 'account' ? (
          <>
            <Field
              label={t('alreadySaved')}
              hint={t('alreadySavedHint')}
              error={errorText('alreadySaved')}
            >
              {(p) => (
                <Input
                  {...p}
                  name="alreadySaved"
                  inputMode="decimal"
                  autoComplete="off"
                  value={values.alreadySaved}
                  className="text-right tabular-nums"
                  onChange={(e) => set('alreadySaved', e.target.value)}
                />
              )}
            </Field>
            <Field
              label={t('alreadySavedDate')}
              hint={t('alreadySavedDateHint')}
              error={errorText('alreadySavedDate')}
            >
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  name="alreadySavedDate"
                  max={data.today}
                  value={values.alreadySavedDate}
                  onChange={(e) => set('alreadySavedDate', e.target.value)}
                />
              )}
            </Field>
          </>
        ) : null}
      </FormCard>

      <SaveBar
        dirty={dirty}
        dirtyText={t('dirty')}
        pending={pending}
        saveLabel={common('save')}
        savingLabel={common('saving')}
        cancelLabel={common('cancel')}
        onCancel={() => leave(back)}
      />
    </form>
  );
}
