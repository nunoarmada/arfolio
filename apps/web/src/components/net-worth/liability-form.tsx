'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition, type FormEvent } from 'react';
import { addMonths as addCalendarMonths, annuityPayment } from '@arfolio/core';
import { parsePlanned, toPlannedInput } from '@/lib/amount-input';
import { formatMonth, isIsoDate } from '@/lib/dates';
import { ASSET_GROUP_ORDER } from '@/lib/net-worth-items';
import { bpsToInput, parsePercent, parseTermInput, splitTerm } from '@/lib/net-worth-schedule';
import { createLiabilityAction, updateLiabilityAction } from '@/server/actions/net-worth';
import type { ActionFailure } from '@/server/actions/result';
import type { LiabilityFormData } from '@/server/net-worth-data';
import { useHouseholdFormat } from '../household-format';
import { Alert } from '../ui/alert';
import { Field, Input } from '../ui/field';
import { Select } from '../ui/select';
import { Textarea } from '../ui/textarea';
import { useToast } from '../ui/toast';
import { useFailureMessage } from '../use-action-error';
import { useLeaveGuard } from '../use-leave-guard';
import { ErrorSummary, FormCard, KindCards, SaveBar } from './form-parts';
import { useFormatMoney } from '@/components/privacy';

const KINDS = ['mortgage', 'loan', 'card', 'debt', 'other'] as const;
type Kind = (typeof KINDS)[number];
/** A plan is the norm for these; the others get it behind "Adicionar plano". */
const PLAN_KINDS: ReadonlySet<string> = new Set(['mortgage', 'loan']);
const MAX_RATE_BPS = 100_000;

interface Values {
  kind: Kind;
  name: string;
  notes: string;
  currency: string;
  accountId: string;
  assetId: string;
  principal: string;
  rate: string;
  years: string;
  months: string;
  startDate: string;
  balance: string;
  balanceDate: string;
}

/** Add or change a liability: what it is, who supplies its balance, and its repayment plan. */
export function LiabilityForm({
  data,
  defaultKind,
  currencies,
  back,
}: {
  data: LiabilityFormData;
  defaultKind: string;
  currencies: Array<{ value: string; label: string }>;
  back: string;
}) {
  const t = useTranslations('liability.form');
  const s = useTranslations('schedule');
  const kinds = useTranslations('netWorth.kind');
  const assetKinds = useTranslations('netWorth.kinds.asset');
  const common = useTranslations('common');
  const router = useRouter();
  const toast = useToast();
  const failure = useFailureMessage();
  const { locale } = useHouseholdFormat();
  const formatMoney = useFormatMoney();
  const editing = data.liability;

  const initial: Values = useMemo(() => {
    const term = editing?.termMonths != null ? splitTerm(editing.termMonths) : null;
    return {
      kind: (KINDS.find((k) => k === (editing?.kind ?? defaultKind)) ?? 'mortgage') as Kind,
      name: editing?.name ?? '',
      notes: editing?.notes ?? '',
      currency: editing?.currency ?? data.currency,
      accountId: editing?.accountId ?? '',
      assetId: editing?.assetId ?? '',
      principal: editing?.principal != null ? toPlannedInput(editing.principal, locale) : '',
      rate: editing?.annualRateBps != null ? bpsToInput(editing.annualRateBps, locale) : '',
      years: term && term.years > 0 ? String(term.years) : '',
      months: term && term.months > 0 ? String(term.months) : '',
      startDate: editing?.startDate ?? '',
      balance: '',
      balanceDate: data.today,
    };
  }, [editing, defaultKind, data.currency, data.today, locale]);
  const [values, setValues] = useState<Values>(initial);
  const [saved, setSaved] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const dirty = !saved && JSON.stringify(values) !== JSON.stringify(initial);
  const { dialog, leave } = useLeaveGuard(dirty);

  const set = <K extends keyof Values>(key: K, value: Values[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: '', schedule: '' }));
  };
  const linked = values.accountId !== '';
  // A card cannot be linked to an asset: the field goes away, its value waits in case the kind changes back.
  const assetField = values.kind !== 'card';

  // The assets a credit can be linked to, by kind, names A to Z; a gone asset keeps its place with its state.
  const assetGroups = useMemo(() => {
    const label = (a: (typeof data.assetOptions)[number]) =>
      a.disposalKind === 'sold'
        ? t('assetSold', { name: a.name })
        : a.disposalKind === 'written_off'
          ? t('assetWrittenOff', { name: a.name })
          : a.archived
            ? t('assetArchived', { name: a.name })
            : a.name;
    const kindsPresent = [...new Set(data.assetOptions.map((a) => a.kind))].sort((a, b) => {
      const rank = (k: string) => {
        const at = (ASSET_GROUP_ORDER as readonly string[]).indexOf(k);
        return at === -1 ? ASSET_GROUP_ORDER.length : at;
      };
      return rank(a) - rank(b) || a.localeCompare(b);
    });
    return kindsPresent.map((kind) => ({
      kind,
      options: data.assetOptions
        .filter((a) => a.kind === kind)
        .sort((a, b) => a.name.localeCompare(b.name, locale))
        .map((a) => ({ id: a.id, label: label(a) })),
    }));
  }, [data.assetOptions, locale, t]);

  // The plan fields as parsed (for validation and the live preview).
  const plan = useMemo(() => {
    const principal = parsePlanned(values.principal);
    const rate = parsePercent(values.rate);
    const term = parseTermInput(values.years, values.months);
    return {
      principal: values.principal.trim() === '' ? null : principal,
      rate: rate.ok ? rate : rate.reason === 'empty' ? null : rate,
      term: term.ok ? term : term.reason === 'empty' ? null : term,
      start: values.startDate === '' ? null : values.startDate,
    };
  }, [values.principal, values.rate, values.years, values.months, values.startDate]);
  const filled = [plan.principal, plan.rate, plan.term, plan.start].filter(
    (f) => f !== null,
  ).length;

  const preview = useMemo(() => {
    if (
      !plan.principal?.ok ||
      !plan.rate?.ok ||
      !plan.term?.ok ||
      !plan.start ||
      !isIsoDate(plan.start) ||
      plan.principal.minor <= 0 ||
      plan.rate.bps > MAX_RATE_BPS
    ) {
      return null;
    }
    try {
      const payment = annuityPayment(plan.principal.minor, plan.rate.bps, plan.term.months);
      const end = addCalendarMonths(plan.start, plan.term.months);
      return s('preview', {
        payment: formatMoney(payment, values.currency, locale),
        end: formatMonth(end, locale),
      });
    } catch {
      return null;
    }
  }, [plan, values.currency, locale, s, formatMoney]);

  const labels: Record<string, string> = {
    name: t('name'),
    principal: s('principal'),
    rate: s('rateField'),
    years: s('termLegend'),
    startDate: s('startDate'),
    schedule: s('fieldset'),
    balance: t('value'),
    balanceDate: t('date'),
    assetId: t('asset'),
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setFormError(null);
    const found: Record<string, string> = {};
    if (!values.name.trim()) found.name = t('nameRequired');

    let schedule: {
      principal: number;
      annualRateBps: number;
      termMonths: number;
      startDate: string;
    } | null = null;
    if (filled > 0 && filled < 4) {
      found.schedule = s('allOrNone');
    } else if (filled === 4) {
      if (!plan.principal?.ok || plan.principal.minor <= 0) found.principal = s('principalInvalid');
      if (!plan.rate?.ok || plan.rate.bps > MAX_RATE_BPS) found.rate = s('rateInvalid');
      if (!plan.term?.ok) found.years = s('termInvalid');
      if (!plan.start || !isIsoDate(plan.start)) found.startDate = s('startInvalid');
      if (
        plan.principal?.ok &&
        plan.rate?.ok &&
        plan.term?.ok &&
        plan.start &&
        Object.keys(found).length === 0
      ) {
        schedule = {
          principal: plan.principal.minor,
          annualRateBps: plan.rate.bps,
          termMonths: plan.term.months,
          startDate: plan.start,
        };
      }
    }

    let initialBalance: { asOf: string; amount: number } | null = null;
    if (!editing && !linked && values.balance.trim() !== '') {
      const parsed = parsePlanned(values.balance);
      if (!parsed.ok) found.balance = t('valueInvalid');
      if (!values.balanceDate) found.balanceDate = t('dateRequired');
      else if (!isIsoDate(values.balanceDate)) found.balanceDate = t('dateInvalid');
      if (parsed.ok && !found.balanceDate) {
        initialBalance = { asOf: values.balanceDate, amount: parsed.minor };
      }
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const input = {
      kind: values.kind,
      name: values.name.trim(),
      notes: values.notes.trim() || null,
      accountId: values.accountId || null,
      assetId: assetField ? values.assetId || null : null,
      schedule,
    };
    start(async () => {
      const result = editing
        ? await updateLiabilityAction(editing.id, input)
        : await createLiabilityAction({
            ...input,
            currency: values.currency,
            initial: initialBalance,
          });
      if (!result.ok) {
        const detail = result.code === 'validation' ? result.detail : undefined;
        const code = detail?.code;
        if (code === 'card_cannot_link_asset' || code === 'asset_not_live') {
          setErrors({ assetId: failure(result) });
          return;
        }
        setFormError(
          code === 'account_already_linked'
            ? t('accountTaken', { name: String(detail?.params?.name ?? '') })
            : failure(result),
        );
        return;
      }
      setSaved(true);
      const failedValue = (result.data as { valueFailure?: ActionFailure | null }).valueFailure;
      // One message: created, but the first value was not saved, and why.
      if (failedValue) toast.warning(t('valueFailed', { reason: failure(failedValue) }));
      else toast.success(editing ? t('saved') : t('created'));
      router.push(`/net-worth/liabilities/${result.data.id}`);
    });
  }

  const messages = Object.entries(errors)
    .filter(([, v]) => v)
    .map(([field, message]) => ({ field, label: labels[field] ?? field, message }));

  // "Definir plano" lands here with #schedule: open the optional plan and bring it into view.
  const planFilled = filled > 0;
  const [planOpen, setPlanOpen] = useState(planFilled);
  useEffect(() => {
    if (window.location.hash === '#schedule') {
      setPlanOpen(true);
      document.getElementById('schedule')?.scrollIntoView({ block: 'start' });
    }
  }, []);

  const scheduleFields = (
    <FormCard
      id="schedule"
      tabIndex={-1}
      aria-describedby={errors.schedule ? 'schedule-error' : undefined}
      legend={s('fieldset')}
      fieldsetClassName="scroll-mt-20"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={s('principal')} error={errors.principal}>
          {(p) => (
            <Input
              {...p}
              name="principal"
              inputMode="decimal"
              autoComplete="off"
              value={values.principal}
              className="text-right tabular-nums"
              onChange={(e) => set('principal', e.target.value)}
            />
          )}
        </Field>
        <Field label={s('rateField')} error={errors.rate}>
          {(p) => (
            <Input
              {...p}
              name="rate"
              inputMode="decimal"
              autoComplete="off"
              value={values.rate}
              className="text-right tabular-nums"
              onChange={(e) => set('rate', e.target.value)}
            />
          )}
        </Field>
      </div>
      <fieldset className="m-0 grid min-w-0 grid-cols-1 gap-1.5 border-0 p-0">
        <legend className="mb-1 p-0 text-sm font-medium">{s('termLegend')}</legend>
        <div className="grid grid-cols-2 gap-4">
          <Field label={s('years')} error={errors.years}>
            {(p) => (
              <Input
                {...p}
                name="years"
                inputMode="numeric"
                autoComplete="off"
                value={values.years}
                className="text-right tabular-nums"
                onChange={(e) => set('years', e.target.value)}
              />
            )}
          </Field>
          <Field label={s('months')}>
            {(p) => (
              <Input
                {...p}
                name="months"
                inputMode="numeric"
                autoComplete="off"
                value={values.months}
                className="text-right tabular-nums"
                onChange={(e) => set('months', e.target.value)}
              />
            )}
          </Field>
        </div>
      </fieldset>
      <Field label={s('startDate')} error={errors.startDate} className="max-w-60">
        {(p) => (
          <Input
            {...p}
            type="date"
            name="startDate"
            value={values.startDate}
            onChange={(e) => set('startDate', e.target.value)}
          />
        )}
      </Field>
      {errors.schedule ? (
        <p id="schedule-error" className="text-sm text-negative">
          {errors.schedule}
        </p>
      ) : null}
      <p
        aria-live="polite"
        data-testid="schedule-preview"
        className="min-h-6 text-sm font-medium tabular-nums"
      >
        {preview ?? ''}
      </p>
    </FormCard>
  );

  return (
    <form
      method="post"
      onSubmit={submit}
      noValidate
      className="grid grid-cols-1 max-w-[640px] gap-5"
    >
      {dialog}
      {submitted ? (
        <ErrorSummary title={t('summary', { count: messages.length })} items={messages} />
      ) : null}
      {formError ? <Alert tone="error">{formError}</Alert> : null}

      <KindCards
        legend={t('kind')}
        name="kind"
        side="liability"
        value={values.kind}
        options={KINDS.map((k) => ({ value: k, label: kinds(k) }))}
        onChange={(v) => set('kind', v as Kind)}
      />

      <FormCard legend={t('sectionBasics')}>
        <Field label={t('name')} error={errors.name}>
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

        <Field label={t('notes')}>
          {(p) => (
            <Textarea
              {...p}
              name="notes"
              rows={3}
              maxLength={2000}
              value={values.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          )}
        </Field>
      </FormCard>

      <FormCard legend={t('sectionMoney')}>
        <Field label={t('currency')} hint={editing ? t('currencyFixed') : t('currencyHint')}>
          {(p) => (
            <Select
              {...p}
              name="currency"
              value={values.currency}
              disabled={editing !== null}
              onChange={(e) => set('currency', e.target.value)}
            >
              {(currencies.some((c) => c.value === values.currency)
                ? currencies
                : [{ value: values.currency, label: values.currency }, ...currencies]
              ).map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label={t('account')} hint={t('accountHint')}>
          {(p) => (
            <Select
              {...p}
              name="accountId"
              value={values.accountId}
              onChange={(e) => set('accountId', e.target.value)}
            >
              <option value="">{t('accountNone')}</option>
              {data.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        {assetField ? (
          <Field
            label={t('asset')}
            hint={assetGroups.length === 0 ? t('assetHintNone') : t('assetHint')}
            error={errors.assetId}
          >
            {(p) => (
              <Select
                {...p}
                name="assetId"
                value={values.assetId}
                onChange={(e) => set('assetId', e.target.value)}
              >
                <option value="">{t('assetNone')}</option>
                {assetGroups.map((group) => (
                  <optgroup key={group.kind} label={assetKinds(group.kind)}>
                    {group.options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
      </FormCard>

      {PLAN_KINDS.has(values.kind) ? (
        scheduleFields
      ) : (
        <details
          open={planOpen || planFilled}
          onToggle={(e) => setPlanOpen((e.currentTarget as HTMLDetailsElement).open)}
          className="grid grid-cols-1 gap-3"
        >
          <summary className="flex min-h-11 cursor-pointer items-center text-base font-medium text-primary underline-offset-4 hover:underline">
            {s('optional')}
          </summary>
          {scheduleFields}
        </details>
      )}

      {!editing && !linked ? (
        <FormCard legend={t('initialValue')}>
          <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
            <Field label={t('value')} error={errors.balance}>
              {(p) => (
                <Input
                  {...p}
                  name="balance"
                  inputMode="decimal"
                  autoComplete="off"
                  value={values.balance}
                  className="text-right tabular-nums"
                  onChange={(e) => set('balance', e.target.value)}
                />
              )}
            </Field>
            <Field label={t('date')} hint={t('dateHint')} error={errors.balanceDate}>
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  name="balanceDate"
                  value={values.balanceDate}
                  onChange={(e) => set('balanceDate', e.target.value)}
                />
              )}
            </Field>
          </div>
          <p className="text-sm text-muted-foreground">{t('balanceHint')}</p>
        </FormCard>
      ) : null}

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
