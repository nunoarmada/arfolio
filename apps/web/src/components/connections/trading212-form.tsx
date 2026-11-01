'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input, PasswordInput } from '@/components/ui/field';
import { useHydrated } from '@/lib/use-hydrated';
import { addTrading212Action, updateTrading212Action } from '@/server/actions/connections';

const SCOPES = [
  'account',
  'portfolio',
  'pies:read',
  'history:transactions',
  'history:dividends',
  'history:orders',
];

type FormError = 'auth' | 'rate' | 'unavailable' | 'different_account' | 'busy' | 'error';

/**
 * Key and secret for Trading 212. The pair is checked with Trading 212 before anything is stored
 * (encrypted), and is cleared from this page as soon as it is saved. With `connection` it
 * replaces the key of that connection instead of creating one (no name to ask for).
 */
export function Trading212Form({
  connection,
}: {
  connection?: { id: string; displayName: string };
}) {
  const t = useTranslations('t212');
  const router = useRouter();
  const hydrated = useHydrated();
  const [name, setName] = useState('Trading 212');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; key?: string; secret?: string }>(
    {},
  );
  const [error, setError] = useState<FormError | null>(null);
  const [pending, setPending] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const hasProblem = error !== null || Object.keys(fieldErrors).length > 0;

  useEffect(() => {
    if (hasProblem) summaryRef.current?.focus();
  }, [hasProblem, fieldErrors, error]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    const errors: typeof fieldErrors = {};
    if (!connection && !name.trim()) errors.name = t('errName');
    if (!apiKey.trim()) errors.key = t('errKey');
    if (!apiSecret.trim()) errors.secret = t('errSecret');
    setFieldErrors(errors);
    setError(null);
    if (Object.keys(errors).length > 0) return;
    setPending(true);
    try {
      if (connection) {
        const updated = await updateTrading212Action({
          connectionId: connection.id,
          apiKey: apiKey.trim(),
          apiSecret: apiSecret.trim(),
        });
        if (updated.ok) {
          setApiKey('');
          setApiSecret('');
          router.push(`/connections?result=key_updated&id=${connection.id}`);
          return;
        }
        setError(
          updated.error === 'auth' ||
            updated.error === 'rate' ||
            updated.error === 'unavailable' ||
            updated.error === 'different_account' ||
            updated.error === 'busy'
            ? updated.error
            : 'error',
        );
        setPending(false);
        return;
      }
      const result = await addTrading212Action({
        apiKey: apiKey.trim(),
        apiSecret: apiSecret.trim(),
        displayName: name.trim(),
      });
      if (result.ok) {
        setApiKey('');
        setApiSecret('');
        router.push(`/connections/${result.connectionId}/link?from=t212`);
        return;
      }
      setError(
        result.error === 'auth' || result.error === 'rate' || result.error === 'unavailable'
          ? result.error
          : 'error',
      );
    } catch {
      setError('error');
    }
    setPending(false);
  }

  const errorText: Record<FormError, string> = {
    auth: t('errAuth'),
    rate: t('errRate'),
    unavailable: t('errUnavailable'),
    different_account: t('errDifferentAccount'),
    busy: t('errBusy'),
    error: t('errGeneric'),
  };

  return (
    <form
      method="post"
      onSubmit={submit}
      noValidate
      className="grid grid-cols-1 max-w-[640px] gap-5"
    >
      <p className="max-w-[68ch] text-base">{connection ? t('updateLead') : t('lead')}</p>

      <section aria-labelledby="t212-how" className="grid grid-cols-1 max-w-[68ch] gap-2">
        <h2 id="t212-how" className="text-lg font-semibold">
          {t('howTitle')}
        </h2>
        <ol className="grid grid-cols-1 list-decimal gap-2 pl-5 text-base marker:text-muted-foreground">
          <li>{t('step1')}</li>
          <li>
            {t('step2')}
            <span className="mt-2 flex flex-wrap gap-1.5">
              {SCOPES.map((s) => (
                <span key={s} className="rounded-sm bg-surface-2 px-2 py-0.5 text-sm font-medium">
                  {s}
                </span>
              ))}
            </span>
          </li>
          <li>{t('step3')}</li>
          <li>{t('step4')}</li>
        </ol>
      </section>

      {hasProblem ? (
        <div ref={summaryRef} tabIndex={-1} className="rounded-lg outline-none">
          <Alert tone="error" title={error ? undefined : t('summaryTitle')}>
            {error ? (
              errorText[error]
            ) : (
              <ul className="grid grid-cols-1 list-disc gap-1 pl-4">
                {fieldErrors.name ? <li>{fieldErrors.name}</li> : null}
                {fieldErrors.key ? <li>{fieldErrors.key}</li> : null}
                {fieldErrors.secret ? <li>{fieldErrors.secret}</li> : null}
              </ul>
            )}
          </Alert>
        </div>
      ) : null}

      {connection ? null : (
        <Field label={t('name')} error={fieldErrors.name}>
          {(p) => (
            <Input
              {...p}
              value={name}
              maxLength={120}
              readOnly={pending}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
      )}
      <Field label={t('apiKey')} error={fieldErrors.key}>
        {(p) => (
          <Input
            {...p}
            value={apiKey}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            readOnly={pending}
            onChange={(e) => setApiKey(e.target.value)}
          />
        )}
      </Field>
      <Field label={t('apiSecret')} hint={t('secretHint')} error={fieldErrors.secret}>
        {(p) => (
          <PasswordInput
            {...p}
            value={apiSecret}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            readOnly={pending}
            showLabel={t('showSecret')}
            hideLabel={t('hideSecret')}
            onChange={(e) => setApiSecret(e.target.value)}
          />
        )}
      </Field>

      <Button
        type="submit"
        size="lg"
        loading={pending}
        disabled={!hydrated}
        className="max-md:w-full md:justify-self-start"
      >
        {pending ? t('submitting') : connection ? t('updateSubmit') : t('submit')}
      </Button>
    </form>
  );
}
