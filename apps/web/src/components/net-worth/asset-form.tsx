'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useMemo, useState, useTransition, type FormEvent } from 'react';
import { AI_VALUATION_KINDS, aiReadiness } from '@arfolio/core';
import { parsePlanned } from '@/lib/amount-input';
import { detailFieldsFor, detailsToValues, valuesToDetails } from '@/lib/asset-details-form';
import { isIsoDate } from '@/lib/dates';
import { bpsToInput, parsePercent } from '@/lib/net-worth-schedule';
import { createAssetAction, updateAssetAction } from '@/server/actions/net-worth';
import type { ActionFailure } from '@/server/actions/result';
import type { AssetFormData } from '@/server/net-worth-data';
import { useHouseholdFormat } from '../household-format';
import { Alert } from '../ui/alert';
import { Card } from '../ui/card';
import { Field, Input } from '../ui/field';
import { Select } from '../ui/select';
import { Switch } from '../ui/switch';
import { Textarea } from '../ui/textarea';
import { useToast } from '../ui/toast';
import { useFailureMessage } from '../use-action-error';
import { useLeaveGuard } from '../use-leave-guard';
import { AssetDetailsFields } from './asset-details-fields';
import { ErrorSummary, FormCard, KindCards, SaveBar } from './form-parts';

const KINDS = ['real_estate', 'vehicle', 'investment', 'cash', 'other'] as const;
type Kind = (typeof KINDS)[number];

interface Values {
  kind: Kind;
  name: string;
  notes: string;
  currency: string;
  accountId: string;
  value: string;
  date: string;
  depreciation: string;
  /** Typed details per kind, so switching kind back and forth loses nothing. */
  details: Record<string, Record<string, string>>;
  aiValuation: boolean;
}

/** Which message explains a detail that failed to parse. */
const invalidKind = (key: string) =>
  key === 'postalCode' ? 'postalCode' : key === 'year' || key === 'yearBuilt' ? 'year' : 'number';

/** Add or change an asset: what it is, whether an account supplies its value, and a first value. */
export function AssetForm({
  data,
  defaultKind,
  currencies,
  back,
}: {
  data: AssetFormData;
  defaultKind: string;
  currencies: Array<{ value: string; label: string }>;
  back: string;
}) {
  const t = useTranslations('asset.form');
  const kinds = useTranslations('netWorth.kind');
  const common = useTranslations('common');
  const router = useRouter();
  const toast = useToast();
  const failure = useFailureMessage();
  const { locale } = useHouseholdFormat();
  const editing = data.asset;

  const initial: Values = useMemo(
    () => ({
      kind: (KINDS.find((k) => k === (editing?.kind ?? defaultKind)) ?? 'real_estate') as Kind,
      name: editing?.name ?? '',
      notes: editing?.notes ?? '',
      currency: editing?.currency ?? data.currency,
      accountId: editing?.accountId ?? '',
      value: '',
      date: data.today,
      depreciation:
        editing?.depreciationBps != null ? bpsToInput(editing.depreciationBps, locale) : '',
      details: editing
        ? { [editing.kind]: detailsToValues(editing.kind, editing.details, locale) }
        : {},
      aiValuation: editing?.aiValuation ?? false,
    }),
    [editing, defaultKind, data.currency, data.today, locale],
  );
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
    setErrors((e) => ({ ...e, [key]: '' }));
  };
  const linked = values.accountId !== '';
  const detailValues = values.details[values.kind] ?? {};
  const aiEligible = (AI_VALUATION_KINDS as readonly string[]).includes(values.kind) && !linked;
  const aiOn = aiEligible && values.aiValuation;
  const detailsText = useTranslations('asset.details');
  const aiLabelId = useId();
  const aiHintId = useId();

  const ai = useTranslations('asset.ai');
  const missing = useMemo(
    () =>
      aiOn
        ? aiReadiness(values.kind, valuesToDetails(values.kind, detailValues).details).missing
        : [],
    [aiOn, values.kind, detailValues],
  );
  const setDetail = (key: string, value: string) => {
    setValues((v) => ({
      ...v,
      details: { ...v.details, [v.kind]: { ...v.details[v.kind], [key]: value } },
    }));
    setErrors((e) => ({ ...e, [`details.${key}`]: '' }));
  };
  const labels: Record<string, string> = {
    name: t('name'),
    value: t('value'),
    date: t('date'),
    depreciation: t('depreciation'),
    ...Object.fromEntries(
      detailFieldsFor(values.kind).map((f) => [`details.${f.key}`, detailsText(`field.${f.key}`)]),
    ),
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setFormError(null);
    const found: Record<string, string> = {};
    if (!values.name.trim()) found.name = t('nameRequired');

    const { details, invalid } = valuesToDetails(values.kind, detailValues);
    for (const key of invalid) found[`details.${key}`] = detailsText(`invalid.${invalidKind(key)}`);

    let depreciationBps: number | null = null;
    if (values.kind === 'vehicle' && !aiOn && values.depreciation.trim() !== '') {
      const rate = parsePercent(values.depreciation);
      if (!rate.ok || rate.bps > 10_000) found.depreciation = t('depreciationInvalid');
      else depreciationBps = rate.bps;
    }

    let initialValue: { asOf: string; amount: number } | null = null;
    if (!editing && !linked && values.value.trim() !== '') {
      const parsed = parsePlanned(values.value);
      if (!parsed.ok) found.value = t('valueInvalid');
      if (!values.date) found.date = t('dateRequired');
      else if (!isIsoDate(values.date)) found.date = t('dateInvalid');
      if (parsed.ok && !found.date) initialValue = { asOf: values.date, amount: parsed.minor };
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const input = {
      kind: values.kind,
      name: values.name.trim(),
      notes: values.notes.trim() || null,
      accountId: values.accountId || null,
      depreciationBps,
      details,
      aiValuation: aiOn,
    };
    start(async () => {
      const result = editing
        ? await updateAssetAction(editing.id, input)
        : await createAssetAction({ ...input, currency: values.currency, initial: initialValue });
      if (!result.ok) {
        const taken =
          result.code === 'validation' && result.detail?.code === 'account_already_linked';
        setFormError(
          taken
            ? t('accountTaken', { name: String(result.detail?.params?.name ?? '') })
            : failure(result),
        );
        return;
      }
      setSaved(true);
      const failedValue = (result.data as { valueFailure?: ActionFailure | null }).valueFailure;
      // One message: created, but the first value was not saved, and why.
      if (failedValue) toast.warning(t('valueFailed', { reason: failure(failedValue) }));
      else toast.success(editing ? t('saved') : t('created'));
      router.push(`/net-worth/assets/${result.data.id}`);
    });
  }

  const messages = Object.entries(errors)
    .filter(([, v]) => v)
    .map(([field, message]) => ({ field, label: labels[field] ?? field, message }));

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
        side="asset"
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

      <AssetDetailsFields
        kind={values.kind}
        values={detailValues}
        errors={Object.fromEntries(
          Object.entries(errors).map(([k, v]) => [k.replace(/^details\./, ''), v]),
        )}
        onChange={setDetail}
      />

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
      </FormCard>

      {aiEligible ? (
        <Card as="section" className="grid grid-cols-1 gap-3">
          <div className="flex items-start justify-between gap-4">
            <div className="grid grid-cols-1 gap-1">
              <h2 id={aiLabelId} className="text-base font-medium">
                {ai('label')}
              </h2>
              <p id={aiHintId} className="text-sm text-muted-foreground">
                {ai('hint')}
              </p>
            </div>
            <Switch
              checked={values.aiValuation}
              onCheckedChange={(next) => set('aiValuation', next)}
              disabled={!data.aiEnabled && !values.aiValuation}
              aria-labelledby={aiLabelId}
              aria-describedby={aiHintId}
            />
          </div>
          {!data.aiEnabled ? (
            <p className="text-sm text-muted-foreground">
              {ai('householdOff')}{' '}
              <Link
                href="/settings/household#ai"
                className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline"
              >
                {ai('householdOffLink')}
              </Link>
            </p>
          ) : null}
          {aiOn && missing.length > 0 ? (
            <Alert tone="info">
              {ai('missing', {
                fields: missing.map((key) => detailsText(`field.${key}`)).join(', '),
              })}
            </Alert>
          ) : null}
        </Card>
      ) : null}

      {values.kind === 'vehicle' && !aiOn ? (
        <Card>
          <Field label={t('depreciation')} hint={t('depreciationHint')} error={errors.depreciation}>
            {(p) => (
              <Input
                {...p}
                name="depreciation"
                inputMode="decimal"
                autoComplete="off"
                value={values.depreciation}
                className="max-w-40 text-right tabular-nums"
                onChange={(e) => set('depreciation', e.target.value)}
              />
            )}
          </Field>
        </Card>
      ) : null}

      {!editing && !linked ? (
        <FormCard legend={t('initialValue')}>
          <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
            <Field label={t('value')} error={errors.value}>
              {(p) => (
                <Input
                  {...p}
                  name="value"
                  inputMode="decimal"
                  autoComplete="off"
                  value={values.value}
                  className="text-right tabular-nums"
                  onChange={(e) => set('value', e.target.value)}
                />
              )}
            </Field>
            <Field label={t('date')} hint={t('dateHint')} error={errors.date}>
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  name="date"
                  value={values.date}
                  onChange={(e) => set('date', e.target.value)}
                />
              )}
            </Field>
          </div>
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
