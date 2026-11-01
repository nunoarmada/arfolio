'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input, PasswordInput } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { LOCALES, LOCALE_LABELS } from '@/i18n/locales';
import type { Option } from '@/lib/format';
import { setupAction, type SetupState } from './actions';

const TOTAL_STEPS = 3; // household, account, then two-step verification on the next page

export function SetupForm({
  defaultToken,
  defaultLocale,
  currencies,
  months,
  timeZones,
  passwordBounds,
}: {
  defaultToken: string;
  defaultLocale: string;
  currencies: Option[];
  months: Option[];
  timeZones: string[];
  passwordBounds: { min: number; max: number };
}) {
  const t = useTranslations('setup');
  const [state, action, pending] = useActionState<SetupState, FormData>(setupAction, {});
  const [step, setStep] = useState<1 | 2>(1);
  const [timeZone, setTimeZone] = useState('UTC');
  const step1 = useRef<HTMLDivElement>(null);
  const heading1 = useRef<HTMLHeadingElement>(null);
  const heading2 = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  // Moving between steps hides the focused button: put focus on the new step's heading.
  useEffect(() => {
    if (!moved.current) return;
    (step === 1 ? heading1 : heading2).current?.focus();
  }, [step]);
  const v = state.values ?? {};
  const fe = state.fieldErrors ?? {};
  const tokenInvalid = state.error === 'invalidToken' || fe.token !== undefined;

  // Default the time zone to the browser's, when the list offers it.
  useEffect(() => {
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (browser && timeZones.includes(browser)) setTimeZone(browser);
  }, [timeZones]);

  // The setup token is a secret: drop it from the address bar once it has been read.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('token')) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  // A server-side problem in step 1 (e.g. household name) sends the person back there.
  useEffect(() => {
    if (state.error === 'invalidToken' || fe.householdName) setStep(1);
  }, [state, fe.householdName]);

  function next() {
    const inputs = step1.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      'input, select',
    );
    for (const el of inputs ?? []) {
      if (!el.reportValidity()) return;
    }
    moved.current = true;
    setStep(2);
  }

  const tokenField = (
    <Field
      label={t('token')}
      hint={t('tokenHint')}
      error={tokenInvalid ? t('errors.invalidToken') : undefined}
    >
      {(p) => (
        <Input
          {...p}
          name="token"
          defaultValue={v.token ?? defaultToken}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
      )}
    </Field>
  );

  return (
    <form action={action} className="grid grid-cols-1 gap-5">
      <p className="text-sm font-medium text-muted-foreground" aria-live="polite">
        {t('step', { step, total: TOTAL_STEPS })}
      </p>

      {state.error === 'closed' ? <Alert tone="error">{t('errors.closed')}</Alert> : null}
      {state.error === 'limited' ? <Alert tone="error">{t('errors.limited')}</Alert> : null}
      {state.error === 'unknown' ? <Alert tone="error">{t('errors.unknown')}</Alert> : null}

      <div ref={step1} hidden={step !== 1} className="grid grid-cols-1 gap-4">
        <h2 ref={heading1} tabIndex={-1} className="text-heading outline-none">
          {t('step1Title')}
        </h2>
        <Field
          label={t('householdName')}
          hint={t('householdNameHint')}
          error={fe.householdName ? t('errors.householdName') : undefined}
        >
          {(p) => (
            <Input
              {...p}
              name="householdName"
              defaultValue={v.householdName}
              maxLength={100}
              required
            />
          )}
        </Field>
        <Field label={t('currency')}>
          {(p) => (
            <Select {...p} name="currency" defaultValue={v.currency ?? 'EUR'}>
              {currencies.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('fiscalMonth')} hint={t('fiscalMonthHint')}>
          {(p) => (
            <Select {...p} name="fiscalYearStartMonth" defaultValue={v.fiscalYearStartMonth ?? '1'}>
              {months.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('locale')}>
          {(p) => (
            <Select {...p} name="locale" defaultValue={v.locale ?? defaultLocale}>
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
              value={timeZone}
              onChange={(e) => setTimeZone(e.target.value)}
            >
              {timeZones.map((z) => (
                <option key={z} value={z}>
                  {z.replaceAll('_', ' ')}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {defaultToken === '' ? (
          tokenField
        ) : (
          <input type="hidden" name="token" value={defaultToken} />
        )}
        <Button size="lg" onClick={next}>
          {t('next')}
        </Button>
      </div>

      <div hidden={step !== 2} className="grid grid-cols-1 gap-4">
        <h2 ref={heading2} tabIndex={-1} className="text-heading outline-none">
          {t('step2Title')}
        </h2>
        <Field label={t('name')} error={fe.name ? t('errors.name') : undefined}>
          {(p) => (
            <Input
              {...p}
              name="name"
              defaultValue={v.name}
              autoComplete="name"
              maxLength={100}
              required
            />
          )}
        </Field>
        <Field label={t('email')} error={fe.email ? t('errors.email') : undefined}>
          {(p) => (
            <Input
              {...p}
              name="email"
              type="email"
              defaultValue={v.email}
              autoComplete="username"
              required
            />
          )}
        </Field>
        <Field
          label={t('password')}
          hint={t('passwordHint', { min: passwordBounds.min })}
          error={fe.password ? t('errors.password', passwordBounds) : undefined}
        >
          {(p) => (
            <PasswordInput
              {...p}
              name="password"
              autoComplete="new-password"
              minLength={passwordBounds.min}
              maxLength={passwordBounds.max}
              required
              showLabel={t('showPassword')}
              hideLabel={t('hidePassword')}
            />
          )}
        </Field>
        <Field
          label={t('confirmPassword')}
          error={fe.confirmPassword ? t('errors.passwordMismatch') : undefined}
        >
          {(p) => (
            <PasswordInput
              {...p}
              name="confirmPassword"
              autoComplete="new-password"
              required
              showLabel={t('showPassword')}
              hideLabel={t('hidePassword')}
            />
          )}
        </Field>
        <p className="text-sm text-muted-foreground">{t('next2fa')}</p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button
            variant="outline"
            size="lg"
            onClick={() => {
              moved.current = true;
              setStep(1);
            }}
          >
            {t('back')}
          </Button>
          <Button type="submit" size="lg" loading={pending}>
            {pending ? t('submitting') : t('submit')}
          </Button>
        </div>
      </div>
    </form>
  );
}
