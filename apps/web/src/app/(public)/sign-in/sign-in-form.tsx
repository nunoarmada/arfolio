'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input, PasswordInput } from '@/components/ui/field';
import { authClient } from '@/lib/auth-client';
import { oauthRedirectUrl, oauthSearch } from '@/lib/oauth-continue';
import { useHydrated } from '@/lib/use-hydrated';

type Status =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'invalid' }
  | { kind: 'network' }
  | { kind: 'generic' }
  | { kind: 'limited'; until: number };

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Live "m:ss" until the rate limit lifts; re-enables the form when it reaches zero. */
function LimitedNotice({ until, onDone }: { until: number; onDone: () => void }) {
  const t = useTranslations('signIn');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    if (now >= until) onDone();
  }, [now, until, onDone]);
  return <Alert tone="error">{t('limited', { time: formatCountdown(until - now) })}</Alert>;
}

export function SignInForm({ next }: { next: string }) {
  const t = useTranslations('signIn');
  const router = useRouter();
  const hydrated = useHydrated();
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const submitting = status.kind === 'submitting';
  const locked = status.kind === 'limited';

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || locked) return;
    const form = new FormData(event.currentTarget);
    setStatus({ kind: 'submitting' });
    let retryAfterSeconds = 0;
    try {
      const { data, error } = await authClient.signIn.email(
        { email: String(form.get('email') ?? ''), password: String(form.get('password') ?? '') },
        {
          onError: (ctx) => {
            retryAfterSeconds = Number(ctx.response.headers.get('x-retry-after')) || 0;
          },
        },
      );
      if (error) {
        if (error.status === 429) {
          setStatus({ kind: 'limited', until: Date.now() + (retryAfterSeconds || 60) * 1000 });
        } else if (error.status === 401 || error.status === 400) {
          setStatus({ kind: 'invalid' });
        } else if (!error.status) {
          setStatus({ kind: 'network' });
        } else {
          setStatus({ kind: 'generic' });
        }
        return;
      }
      if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) {
        router.replace(`/two-factor${oauthSearch(window.location.search)}`);
        return;
      }
      // An OAuth authorization (MCP client) started this sign-in: continue it, not `next`.
      const oauthUrl = oauthRedirectUrl(data);
      if (oauthUrl) {
        window.location.assign(oauthUrl);
        return;
      }
      router.replace(next);
      router.refresh();
    } catch {
      setStatus({ kind: 'network' });
    }
  }

  return (
    <form method="post" onSubmit={onSubmit} className="grid grid-cols-1 gap-4" noValidate={false}>
      {status.kind === 'invalid' ? <Alert tone="error">{t('invalid')}</Alert> : null}
      {status.kind === 'network' ? <Alert tone="error">{t('network')}</Alert> : null}
      {status.kind === 'generic' ? <Alert tone="error">{t('generic')}</Alert> : null}
      {status.kind === 'limited' ? (
        <LimitedNotice until={status.until} onDone={() => setStatus({ kind: 'idle' })} />
      ) : null}

      <Field label={t('email')}>
        {(p) => (
          <Input
            {...p}
            name="email"
            type="email"
            autoComplete="username"
            required
            readOnly={submitting}
            autoFocus
          />
        )}
      </Field>
      <Field label={t('password')}>
        {(p) => (
          <PasswordInput
            {...p}
            name="password"
            autoComplete="current-password"
            required
            readOnly={submitting}
            showLabel={t('showPassword')}
            hideLabel={t('hidePassword')}
          />
        )}
      </Field>
      <Button
        type="submit"
        size="lg"
        className="w-full"
        loading={submitting}
        disabled={locked || !hydrated}
      >
        {submitting ? t('submitting') : t('submit')}
      </Button>
    </form>
  );
}
