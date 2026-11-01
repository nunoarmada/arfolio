'use client';

import { KeyRound, MonitorSmartphone, ShieldCheck, ShieldOff } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CopyButton } from '@/components/copy-button';
import { SettingsCard } from '@/components/settings/settings-card';
import { Alert } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, PasswordInput } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { authClient } from '@/lib/auth-client';
import { useHydrated } from '@/lib/use-hydrated';
import { MAX_PASSWORD_LENGTH } from '@/lib/credentials';

interface SessionRow {
  id: string;
  token: string;
  createdAt: Date;
  userAgent?: string | null;
}

/** "Chrome on Linux"-style summary from a user agent; falls back to the caller's label. */
function describeAgent(ua: string | null | undefined, fallback: string): string {
  if (!ua) return fallback;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : null;
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  return browser && os ? `${browser} / ${os}` : (browser ?? os ?? fallback);
}

function PasswordSection({ minPassword }: { minPassword: number }) {
  const hydrated = useHydrated();
  const t = useTranslations('security');
  const errors = useTranslations('errors');
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setProblem(null);
    try {
      const { error } = await authClient.changePassword({
        currentPassword: String(form.get('current')),
        newPassword: String(form.get('next')),
        revokeOtherSessions: form.get('revoke') === 'on',
      });
      if (error) {
        setProblem(
          error.code === 'INVALID_PASSWORD'
            ? t('passwordWrong')
            : error.status
              ? t('passwordError')
              : errors('network'),
        );
        return;
      }
      toast.success(t('passwordChanged'));
      setFormKey((k) => k + 1);
    } catch {
      setProblem(errors('network'));
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsCard titleId="password-title" title={t('passwordTitle')} icon={KeyRound}>
      {problem ? <Alert tone="error">{problem}</Alert> : null}
      <form key={formKey} method="post" onSubmit={onSubmit} className="grid grid-cols-1 gap-4">
        <Field label={t('currentPassword')}>
          {(p) => (
            <PasswordInput
              {...p}
              name="current"
              autoComplete="current-password"
              required
              readOnly={pending}
              showLabel={t('showPassword')}
              hideLabel={t('hidePassword')}
            />
          )}
        </Field>
        <Field label={t('newPassword')} hint={t('newPasswordHint', { min: minPassword })}>
          {(p) => (
            <PasswordInput
              {...p}
              name="next"
              autoComplete="new-password"
              minLength={minPassword}
              maxLength={MAX_PASSWORD_LENGTH}
              required
              readOnly={pending}
              showLabel={t('showPassword')}
              hideLabel={t('hidePassword')}
            />
          )}
        </Field>
        <label className="flex min-h-11 items-center gap-3 text-base">
          <input
            type="checkbox"
            name="revoke"
            defaultChecked
            className="size-5 accent-[var(--primary)]"
          />
          {t('revokeOthers')}
        </label>
        <Button type="submit" loading={pending} disabled={!hydrated} className="justify-self-start">
          {pending ? t('changing') : t('changePassword')}
        </Button>
      </form>
    </SettingsCard>
  );
}

function TwoFactorSection({ enabled, isOwner }: { enabled: boolean; isOwner: boolean }) {
  const hydrated = useHydrated();
  const t = useTranslations('security');
  const errors = useTranslations('errors');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  async function regenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setProblem(null);
    try {
      const { data, error } = await authClient.twoFactor.generateBackupCodes({
        password: String(form.get('password')),
      });
      if (error || !data) {
        setProblem(
          error?.code === 'INVALID_PASSWORD'
            ? t('passwordWrong')
            : error?.status
              ? t('passwordError')
              : errors('network'),
        );
        return;
      }
      setCodes(data.backupCodes);
      event.currentTarget.reset();
    } catch {
      setProblem(errors('network'));
    } finally {
      setPending(false);
    }
  }

  return (
    <SettingsCard titleId="2fa-title" title={t('twoFactorTitle')} icon={ShieldCheck}>
      <Card variant="inset" pad="sm" className="flex items-start gap-3">
        {enabled ? (
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-positive" aria-hidden="true" />
        ) : (
          <ShieldOff className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
        )}
        <p className="text-base">
          {enabled ? t('twoFactorOn') : t('twoFactorOff')}
          {isOwner ? ` ${t('twoFactorOwners')}` : ''}
        </p>
      </Card>
      {!enabled ? (
        <Link
          href="/two-factor/setup"
          className={buttonVariants({ className: 'justify-self-start' })}
        >
          {t('enable')}
        </Link>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          <h3 className="text-card-title">{t('regenTitle')}</h3>
          <p className="text-sm text-muted-foreground">{t('regenIntro')}</p>
          {problem ? <Alert tone="error">{problem}</Alert> : null}
          <form method="post" onSubmit={regenerate} className="grid grid-cols-1 gap-4">
            <Field label={t('currentPassword')}>
              {(p) => (
                <PasswordInput
                  {...p}
                  name="password"
                  autoComplete="current-password"
                  required
                  readOnly={pending}
                  showLabel={t('showPassword')}
                  hideLabel={t('hidePassword')}
                />
              )}
            </Field>
            <Button
              type="submit"
              variant="outline"
              loading={pending}
              disabled={!hydrated}
              className="justify-self-start"
            >
              {pending ? t('regenerating') : t('regenerate')}
            </Button>
          </form>
          {codes ? (
            <Alert tone="success" title={t('regenDone')}>
              <ul className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 font-medium tabular-nums">
                {codes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <div className="mt-3">
                <CopyButton text={codes.join('\n')} label={t('copyCodes')} />
              </div>
            </Alert>
          ) : null}
        </div>
      )}
    </SettingsCard>
  );
}

function SessionsSection({ currentSessionId }: { currentSessionId: string }) {
  const t = useTranslations('security');
  const common = useTranslations('common');
  const toast = useToast();
  const format = useFormatter();
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [ending, setEnding] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const { data, error } = await authClient.listSessions();
      if (error || !data) throw new Error('list failed');
      setRows(
        data
          .map((s) => ({
            id: s.id,
            token: s.token,
            createdAt: new Date(s.createdAt),
            userAgent: s.userAgent,
          }))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      );
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function end(token: string) {
    setEnding(token);
    try {
      const { error } = await authClient.revokeSession({ token });
      if (error) throw new Error('revoke failed');
      toast.success(t('sessionEnded'));
      await load();
    } catch {
      toast.error(t('sessionsError'));
    } finally {
      setEnding(null);
    }
  }

  return (
    <SettingsCard
      titleId="sessions-title"
      title={t('sessionsTitle')}
      icon={MonitorSmartphone}
      flush={rows !== null && !failed}
    >
      {failed ? (
        <Alert
          tone="error"
          action={
            <Button variant="outline" onClick={() => void load()}>
              {common('retry')}
            </Button>
          }
        >
          {t('sessionsError')}
        </Alert>
      ) : rows === null ? (
        <div role="status" aria-busy="true" className="grid grid-cols-1 gap-2">
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((s) => {
            const date = format.dateTime(s.createdAt, { dateStyle: 'medium', timeStyle: 'short' });
            const current = s.id === currentSessionId;
            return (
              <li
                key={s.token}
                className="flex min-h-16 items-center gap-3 px-4 py-2 md:px-5 xl:px-6"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-medium">
                    {describeAgent(s.userAgent, t('unknownDevice'))}
                    {current ? ` (${t('currentSession')})` : ''}
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    {t('sessionStarted', { date })}
                  </span>
                </span>
                {!current ? (
                  <Button
                    variant="outline"
                    aria-label={t('endSessionLabel', { date })}
                    loading={ending === s.token}
                    onClick={() => void end(s.token)}
                  >
                    {t('endSession')}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </SettingsCard>
  );
}

export function SecurityView({
  twoFactorEnabled,
  isOwner,
  currentSessionId,
  minPassword,
}: {
  twoFactorEnabled: boolean;
  isOwner: boolean;
  currentSessionId: string;
  minPassword: number;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 md:gap-5">
      <PasswordSection minPassword={minPassword} />
      <TwoFactorSection enabled={twoFactorEnabled} isOwner={isOwner} />
      <SessionsSection currentSessionId={currentSessionId} />
    </div>
  );
}
