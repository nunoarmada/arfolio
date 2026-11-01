'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createTokenAction } from '@/server/actions/integrations';
import { useHydrated } from '@/lib/use-hydrated';
import { cn } from '@/lib/cn';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Field, Input } from '../ui/field';
import { Sheet } from '../ui/sheet';

const FORM_ID = 'create-token-form';
const EXPIRIES = [
  { days: 30, key: 'expiry30' },
  { days: 90, key: 'expiry90' },
  { days: 365, key: 'expiry365' },
  { days: null, key: 'expiryNever' },
] as const;

type Scope = 'read' | 'read_write';
type Expiry = (typeof EXPIRIES)[number]['days'];
export interface CreatedToken {
  token: string;
  id: string;
  name: string;
}

/**
 * The create-token sheet. The least-privilege read scope and a 90-day expiry are preselected; a
 * viewer's read_write card is shown but disabled, with the reason. The token comes back once and
 * goes straight to `onCreated`.
 */
export function CreateTokenSheet({
  open,
  onOpenChange,
  viewer,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  viewer: boolean;
  onCreated: (created: CreatedToken) => void;
}) {
  const t = useTranslations('integrations.create');
  const cancel = useTranslations('common')('cancel');
  const hydrated = useHydrated();
  const ids = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  // After a success the reveal dialog owns focus: the sheet must not pull it back.
  const created = useRef(false);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<Scope>('read');
  const [expiry, setExpiry] = useState<Expiry>(90);
  const [nameError, setNameError] = useState<'required' | 'tooLong' | null>(null);
  const [failed, setFailed] = useState<'error' | 'reauth' | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    created.current = false;
    setName('');
    setScope('read');
    setExpiry(90);
    setNameError(null);
    setFailed(null);
    setPending(false);
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const trimmed = name.trim();
    const problem = trimmed === '' ? 'required' : trimmed.length > 60 ? 'tooLong' : null;
    setNameError(problem);
    setFailed(null);
    if (problem) {
      nameInput.current?.focus();
      return;
    }
    setPending(true);
    const result = await createTokenAction({ name: trimmed, scope, expiresInDays: expiry }).catch(
      () => null,
    );
    if (result?.ok) {
      created.current = true;
      onCreated(result.data);
      return;
    }
    setPending(false);
    setFailed(result?.ok === false && result.code === 'reauth' ? 'reauth' : 'error');
  }

  const writeId = `${ids}-write`;
  const reasonId = `${ids}-reason`;
  const card =
    'flex min-h-14 cursor-pointer items-start gap-3 rounded-md border border-input p-3 has-[:checked]:border-primary has-[:checked]:bg-primary-soft';

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
      title={t('title')}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        nameInput.current?.focus();
      }}
      onCloseAutoFocus={(event) => {
        if (created.current) event.preventDefault();
      }}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            {cancel}
          </Button>
          <Button type="submit" form={FORM_ID} disabled={!hydrated} loading={pending}>
            {pending ? t('submitting') : t('submit')}
          </Button>
        </div>
      }
    >
      <form
        id={FORM_ID}
        method="post"
        onSubmit={submit}
        className="grid grid-cols-1 gap-5"
        noValidate
      >
        {failed ? (
          <Alert tone="error">{failed === 'reauth' ? t('reauth') : t('error')}</Alert>
        ) : null}

        <Field
          label={t('name')}
          hint={t('nameHelp')}
          error={
            nameError === 'required'
              ? t('nameRequired')
              : nameError === 'tooLong'
                ? t('nameTooLong')
                : undefined
          }
        >
          {(p) => (
            <Input
              {...p}
              ref={nameInput}
              value={name}
              maxLength={60}
              autoComplete="off"
              required
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>

        <fieldset className="grid grid-cols-1 gap-2">
          <legend className="mb-1.5 text-sm font-medium">{t('scope')}</legend>
          <label className={card}>
            <input
              type="radio"
              name="scope"
              checked={scope === 'read'}
              onChange={() => setScope('read')}
              aria-describedby={`${ids}-read`}
              className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]"
            />
            <span className="grid grid-cols-1 min-w-0 gap-0.5">
              <span className="text-base font-medium">{t('scopeRead')}</span>
              <span id={`${ids}-read`} className="text-sm text-muted-foreground">
                {t('scopeReadHelp')}
              </span>
            </span>
          </label>
          <label className={cn(card, viewer && 'cursor-not-allowed')}>
            <input
              type="radio"
              name="scope"
              checked={scope === 'read_write'}
              disabled={viewer}
              onChange={() => setScope('read_write')}
              aria-describedby={viewer ? `${writeId} ${reasonId}` : writeId}
              className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]"
            />
            <span className="grid grid-cols-1 min-w-0 gap-0.5">
              <span className={cn('text-base font-medium', viewer && 'text-subtle-foreground')}>
                {t('scopeReadWrite')}
              </span>
              <span
                id={writeId}
                className={cn(
                  'text-sm',
                  viewer ? 'text-subtle-foreground' : 'text-muted-foreground',
                )}
              >
                {t('scopeWriteHelp')}
              </span>
            </span>
          </label>
          {viewer ? (
            <p id={reasonId} className="text-sm text-muted-foreground">
              {t('viewerOnly')}
            </p>
          ) : null}
        </fieldset>

        <fieldset className="grid grid-cols-1 gap-2">
          <legend className="mb-1.5 text-sm font-medium">{t('expiry')}</legend>
          <div className="grid grid-cols-2 gap-2">
            {EXPIRIES.map((option) => (
              <label
                key={option.key}
                className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-input px-3 has-[:checked]:border-primary has-[:checked]:bg-primary-soft"
              >
                <input
                  type="radio"
                  name="expiry"
                  checked={expiry === option.days}
                  onChange={() => setExpiry(option.days)}
                  className="size-5 shrink-0 accent-[var(--primary)]"
                />
                <span className="text-base">{t(option.key)}</span>
              </label>
            ))}
          </div>
          {expiry === null ? <Alert tone="warning">{t('neverWarning')}</Alert> : null}
        </fieldset>
      </form>
    </Sheet>
  );
}
