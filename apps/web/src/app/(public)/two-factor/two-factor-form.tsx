'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { OtpInput } from '@/components/ui/otp-input';
import { authClient } from '@/lib/auth-client';
import { oauthRedirectUrl } from '@/lib/oauth-continue';
import { useHydrated } from '@/lib/use-hydrated';

type Mode = 'app' | 'backup';
type Problem = 'invalid' | 'expired' | 'locked' | 'network' | null;

export function TwoFactorForm() {
  const t = useTranslations('twoFactor');
  const errors = useTranslations('errors');
  const router = useRouter();
  const hydrated = useHydrated();
  const [mode, setMode] = useState<Mode>('app');
  const [code, setCode] = useState('');
  const [trust, setTrust] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const otpRef = useRef<HTMLInputElement>(null);
  const backupRef = useRef<HTMLInputElement>(null);

  async function verify(value: string) {
    if (pending || !value) return;
    setPending(true);
    setProblem(null);
    try {
      const { data, error } =
        mode === 'app'
          ? await authClient.twoFactor.verifyTotp({ code: value, trustDevice: trust })
          : await authClient.twoFactor.verifyBackupCode({ code: value.trim(), trustDevice: trust });
      if (error) {
        setProblem(
          error.code === 'INVALID_TWO_FACTOR_COOKIE'
            ? 'expired'
            : error.code === 'ACCOUNT_TEMPORARILY_LOCKED' ||
                error.code === 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE'
              ? 'locked'
              : error.status
                ? 'invalid'
                : 'network',
        );
        setCode('');
        setPending(false);
        // Clear and refocus the field so the next attempt starts clean.
        window.setTimeout(() => (mode === 'app' ? otpRef : backupRef).current?.focus(), 0);
        return;
      }
      // The sign-in that led here belonged to an OAuth authorization: continue it.
      const oauthUrl = oauthRedirectUrl(data);
      if (oauthUrl) {
        window.location.assign(oauthUrl);
        return;
      }
      router.replace('/');
      router.refresh();
    } catch {
      setProblem('network');
      setPending(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void verify(code);
  }

  const message =
    problem === 'invalid'
      ? mode === 'app'
        ? t('invalid')
        : t('invalidBackup')
      : problem === 'expired'
        ? t('expired')
        : problem === 'locked'
          ? t('locked')
          : problem === 'network'
            ? errors('network')
            : null;

  return (
    <form method="post" onSubmit={onSubmit} className="grid grid-cols-1 gap-4">
      <p className="text-base text-muted-foreground">
        {mode === 'app' ? t('intro') : t('backupIntro')}
      </p>
      {message ? (
        <Alert tone="error">
          {message}
          {problem === 'expired' ? (
            <>
              {' '}
              <Link
                href="/sign-in"
                className="font-medium text-primary underline underline-offset-4"
              >
                {t('backToSignIn')}
              </Link>
            </>
          ) : null}
        </Alert>
      ) : null}

      {mode === 'app' ? (
        <OtpInput
          ref={otpRef}
          value={code}
          onChange={setCode}
          onComplete={(v) => void verify(v)}
          invalid={problem === 'invalid'}
          disabled={pending}
          label={t('codeLabel')}
          autoFocus
        />
      ) : (
        <Field label={t('backupLabel')}>
          {(p) => (
            <Input
              {...p}
              ref={backupRef}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              readOnly={pending}
              required
              autoFocus
            />
          )}
        </Field>
      )}

      <label className="flex min-h-11 items-center gap-3 text-base">
        <input
          type="checkbox"
          checked={trust}
          onChange={(e) => setTrust(e.target.checked)}
          className="size-5 accent-[var(--primary)]"
        />
        {t('trust')}
      </label>

      <Button type="submit" size="lg" className="w-full" loading={pending} disabled={!hydrated}>
        {pending ? t('verifying') : t('verify')}
      </Button>
      <Button
        variant="link"
        className="justify-self-start"
        onClick={() => {
          setMode(mode === 'app' ? 'backup' : 'app');
          setCode('');
          setProblem(null);
        }}
      >
        {mode === 'app' ? t('useBackup') : t('useApp')}
      </Button>
    </form>
  );
}
