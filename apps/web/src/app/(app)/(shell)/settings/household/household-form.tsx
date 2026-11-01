'use client';

import { Minus, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useActionState, useEffect, useId, useState } from 'react';
import { formatMoney } from '@arfolio/core';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { LOCALES, LOCALE_LABELS } from '@/i18n/locales';
import { cn } from '@/lib/cn';
import type { Option } from '@/lib/format';
import type { HouseholdSettingsInput } from '@/server/household';
import { saveHouseholdAction, type HouseholdFormState } from './actions';

type Values = HouseholdSettingsInput & { name: string };

export function HouseholdForm({
  initial,
  canEdit,
  currencies,
  timeZones,
  aiAvailable,
  aiModel,
  aiReportModel,
  maxRegenerations,
}: {
  initial: Values;
  canEdit: boolean;
  currencies: Option[];
  timeZones: string[];
  /** The installation has an AI API key (the switch cannot be turned on without one). */
  aiAvailable: boolean;
  aiModel: string;
  aiReportModel: string;
  /** How many times a month's report can be generated again. */
  maxRegenerations: number;
}) {
  const t = useTranslations('household');
  const common = useTranslations('common');
  const ai = useTranslations('aiSettings');
  const toast = useToast();
  const [saved, setSaved] = useState<Values>(initial);
  const [values, setValues] = useState<Values>(initial);
  const [state, action, pending] = useActionState<HouseholdFormState, FormData>(
    saveHouseholdAction,
    {
      status: 'idle',
      at: 0,
    },
  );
  const aiLabelId = useId();
  const aiHelpId = useId();
  const aiReasonId = useId();
  const [aiSavedOff, setAiSavedOff] = useState(false);
  const dirty = JSON.stringify(values) !== JSON.stringify(saved);
  const set = <K extends keyof Values>(key: K, value: Values[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  useEffect(() => {
    if (state.status === 'saved') {
      if (values.aiEnabled !== saved.aiEnabled) {
        toast.success(values.aiEnabled ? ai('savedOn') : ai('savedOff'));
        setAiSavedOff(!values.aiEnabled);
      } else {
        toast.success(t('saved'));
      }
      setSaved(values);
    } else if (state.status === 'error') {
      toast.error(t('saveError'));
    }
    // Only react to a new server outcome, not to later edits.
  }, [state.at]);

  // Leaving with unsaved edits would lose them: let the browser ask.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const example = formatMoney(123456, values.currency, values.locale);
  const readOnly = !canEdit;

  return (
    <form action={action} className="grid grid-cols-1 gap-5">
      {readOnly ? <Alert tone="info">{t('readOnly')}</Alert> : null}
      {state.status === 'forbidden' ? <Alert tone="error">{t('forbidden')}</Alert> : null}
      {state.status === 'invalid' ? <Alert tone="error">{t('invalid')}</Alert> : null}
      {state.status === 'error' ? <Alert tone="error">{t('saveError')}</Alert> : null}

      <Card pad="md" className="grid grid-cols-1 gap-5">
        <Field label={t('name')}>
          {(p) => (
            <Input
              {...p}
              name="name"
              value={values.name}
              maxLength={100}
              required
              readOnly={readOnly}
              onChange={(e) => set('name', e.target.value)}
            />
          )}
        </Field>

        <Field label={t('currency')}>
          {(p) => (
            <Select
              {...p}
              name="currency"
              value={values.currency}
              disabled={readOnly}
              onChange={(e) => set('currency', e.target.value)}
            >
              {currencies.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label={t('locale')} hint={`${t('localeHint')} ${t('example', { amount: example })}`}>
          {(p) => (
            <Select
              {...p}
              name="locale"
              value={values.locale}
              disabled={readOnly}
              onChange={(e) => set('locale', e.target.value as Values['locale'])}
            >
              {LOCALES.map((l) => (
                <option key={l} value={l} lang={l}>
                  {LOCALE_LABELS[l].name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label={t('timezone')}>
          {(p) => (
            <Select
              {...p}
              name="timezone"
              value={values.timezone}
              disabled={readOnly}
              onChange={(e) => set('timezone', e.target.value)}
            >
              {timeZones.map((z) => (
                <option key={z} value={z}>
                  {z.replaceAll('_', ' ')}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div id="emergency-fund" className="scroll-mt-20">
          <Field label={t('emergencyFund')} hint={t('emergencyFundHint')}>
            {(p) => (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t('decrease')}
                  disabled={readOnly || values.emergencyFundMonths <= 0}
                  onClick={() =>
                    set('emergencyFundMonths', Math.max(0, values.emergencyFundMonths - 1))
                  }
                >
                  <Minus className="size-5" aria-hidden="true" />
                </Button>
                <Input
                  {...p}
                  name="emergencyFundMonths"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={60}
                  step={1}
                  value={values.emergencyFundMonths}
                  readOnly={readOnly}
                  onChange={(e) =>
                    set(
                      'emergencyFundMonths',
                      Math.min(60, Math.max(0, Math.trunc(Number(e.target.value) || 0))),
                    )
                  }
                  className="w-20 text-center tabular-nums"
                />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t('increase')}
                  disabled={readOnly || values.emergencyFundMonths >= 60}
                  onClick={() =>
                    set('emergencyFundMonths', Math.min(60, values.emergencyFundMonths + 1))
                  }
                >
                  <Plus className="size-5" aria-hidden="true" />
                </Button>
              </div>
            )}
          </Field>
        </div>
      </Card>

      <section
        id="ai"
        aria-labelledby={aiLabelId}
        className="grid grid-cols-1 scroll-mt-20 gap-4 rounded-lg bg-surface p-4 shadow-card md:p-5 xl:p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="grid grid-cols-1 gap-1">
            <h2 id={aiLabelId} className="text-card-title">
              {ai('title')}
            </h2>
            <p id={aiHelpId} className="text-sm text-muted-foreground">
              {ai('help')}
            </p>
            {canEdit && !aiAvailable ? (
              <p id={aiReasonId} className="text-sm font-medium text-muted-foreground">
                {ai('unavailable')}{' '}
                <Link
                  href="/settings/services#ai"
                  className="inline-flex min-h-11 items-center text-primary-text underline-offset-4 hover:underline"
                >
                  {ai('configureLink')}
                </Link>
              </p>
            ) : null}
          </div>
          {canEdit ? (
            <Switch
              checked={values.aiEnabled}
              onCheckedChange={(next) => set('aiEnabled', next)}
              disabled={!aiAvailable && !values.aiEnabled}
              aria-labelledby={aiLabelId}
              aria-describedby={`${aiHelpId}${aiAvailable ? '' : ` ${aiReasonId}`}`}
            />
          ) : (
            <span className="shrink-0 text-base font-medium">
              {values.aiEnabled ? ai('on') : ai('off')}
            </span>
          )}
          <input type="hidden" name="aiEnabled" value={String(values.aiEnabled)} />
        </div>
        {canEdit ? null : <p className="text-sm text-muted-foreground">{ai('ownerOnly')}</p>}

        <div className="grid grid-cols-1 gap-3 border-t border-border pt-4 text-sm md:grid-cols-2 md:gap-5">
          <div className="grid grid-cols-1 content-start gap-1">
            <h3 className="font-medium">{ai('sentTitle')}</h3>
            <p>
              <span className="font-medium">{ai('sentLabel')}: </span>
              {ai('sentBody')}
            </p>
            <p>
              <span className="font-medium">{ai('reportsSentLabel')}: </span>
              {ai('reportsSentBody')}
            </p>
          </div>
          <div className="grid grid-cols-1 content-start gap-1">
            <p>
              <span className="font-medium">{ai('neverLabel')}: </span>
              {ai('neverBody')}
            </p>
            <p className="text-muted-foreground">{ai('caveat')}</p>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {aiAvailable
            ? `${ai('provider', { model: aiModel, reportModel: aiReportModel })}. `
            : null}
          {ai('limits', { max: maxRegenerations })}
        </p>
        {aiSavedOff && !values.aiEnabled ? (
          <p role="status" className="text-sm">
            <Link
              href="/transactions?by=ai&period=last-90"
              className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline"
            >
              {ai('reviewLink')}
            </Link>
          </p>
        ) : null}
      </section>

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
