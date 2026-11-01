'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input, PasswordInput } from '@/components/ui/field';
import { acceptInviteAction, type InviteState } from './actions';

export function InviteForm({
  invitationId,
  token,
  email,
  passwordBounds,
}: {
  invitationId: string;
  token: string;
  email: string;
  passwordBounds: { min: number; max: number };
}) {
  const t = useTranslations('invite');
  const [state, action, pending] = useActionState<InviteState, FormData>(acceptInviteAction, {});

  // The token now lives in the hidden field below: remove it from the address bar and history.
  useEffect(() => {
    if (window.location.search) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  const formError =
    state.error === 'invalid' || state.error === 'exists' || state.error === 'unknown'
      ? t(`errors.${state.error}`)
      : null;

  return (
    <form action={action} className="grid grid-cols-1 gap-4">
      <input type="hidden" name="invitationId" value={invitationId} />
      <input type="hidden" name="token" value={token} />
      {formError ? <Alert tone="error">{formError}</Alert> : null}
      <Field label={t('name')} error={state.error === 'name' ? t('errors.name') : undefined}>
        {(p) => (
          <Input
            {...p}
            name="name"
            defaultValue={state.name}
            autoComplete="name"
            maxLength={100}
            required
            autoFocus
          />
        )}
      </Field>
      <Field label={t('email')}>
        {(p) => <Input {...p} type="email" value={email} readOnly autoComplete="username" />}
      </Field>
      <Field
        label={t('password')}
        hint={t('passwordHint', { min: passwordBounds.min })}
        error={state.error === 'password' ? t('errors.password', passwordBounds) : undefined}
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
      <Button type="submit" size="lg" className="w-full" loading={pending}>
        {pending ? t('submitting') : t('submit')}
      </Button>
    </form>
  );
}
