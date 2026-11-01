'use client';

import { CalendarClock, Eye, Unplug, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Monogram } from '@/components/account-badge';
import { Alert } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { startBankConsentAction, type StartConsentResult } from '@/server/actions/connections';

type Failure = Extract<StartConsentResult, { ok: false }>['error'];

/** The explanation before the redirect: what happens, what the app can and cannot do, for how long. */
export function AuthorisePanel({
  bank,
  country,
  aspspName,
  connectionId,
  maxConsentDays,
}: {
  bank: string;
  country: string;
  aspspName: string;
  /** Set when renewing an existing connection. */
  connectionId?: string;
  maxConsentDays?: number;
}) {
  const t = useTranslations('consent');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const renew = connectionId !== undefined;

  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);

  async function proceed() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await startBankConsentAction({
        aspspName,
        country,
        ...(connectionId ? { connectionId } : {}),
      });
      if (result.ok) {
        // The bank is another site: a full navigation, and the button stays busy until it happens.
        window.location.assign(result.url);
        return;
      }
      setError(result.error);
    } catch {
      setError('error');
    }
    setPending(false);
  }

  const points: Array<{ icon: LucideIcon; text: string }> = [
    { icon: Eye, text: t('pointReadOnly') },
    {
      icon: CalendarClock,
      text:
        maxConsentDays !== undefined
          ? t('pointValidity', { days: maxConsentDays })
          : t('pointValidityFallback'),
    },
    { icon: Unplug, text: t('pointRevoke') },
  ];
  const message: Record<Failure, string> = {
    not_configured: t('notConfigured'),
    misconfigured: t('errMisconfigured'),
    unknown_bank: t('errUnknownBank'),
    unreachable: t('errUnreachable'),
    gone: t('errGone'),
    forbidden: t('errForbidden'),
    error: t('errUnreachable'),
  };

  return (
    <div className="grid grid-cols-1 max-w-[640px] gap-5">
      <div className="flex items-center gap-3">
        <Monogram name={bank} className="size-12" />
        <p className="min-w-0 truncate text-lg font-medium">{bank}</p>
      </div>

      <section aria-labelledby="authorise-next" className="grid grid-cols-1 max-w-[68ch] gap-2">
        <h2 id="authorise-next" className="text-lg font-semibold">
          {t('whatNext')}
        </h2>
        <p className="text-base">{t('whatNextBody', { bank })}</p>
        <ul className="mt-1 grid grid-cols-1 gap-3">
          {points.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-start gap-3 text-base">
              <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span>{text}</span>
            </li>
          ))}
        </ul>
        {renew ? <p className="text-base">{t('renewNote')}</p> : null}
        <p className="text-sm text-muted-foreground">{t('psd2')}</p>
        <p className="text-sm text-muted-foreground">{t('frequency')}</p>
      </section>

      {error ? (
        <div ref={alertRef} tabIndex={-1} className="rounded-lg outline-none">
          <Alert
            tone="error"
            action={
              error === 'gone' ? (
                <Link
                  href="/connections"
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  {t('goToConnections')}
                </Link>
              ) : undefined
            }
          >
            {message[error]}
          </Alert>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-2 md:flex md:items-center md:gap-4">
        <Button
          size="lg"
          loading={pending}
          onClick={() => void proceed()}
          className="max-md:w-full"
        >
          {pending
            ? t('opening', { bank })
            : renew
              ? t('continueRenew', { bank })
              : t('continue', { bank })}
        </Button>
        {renew ? null : (
          <Link
            href={`/connections/new/bank?country=${encodeURIComponent(country)}`}
            className={buttonVariants({ variant: 'ghost', size: 'lg', className: 'max-md:w-full' })}
          >
            {t('chooseAnother')}
          </Link>
        )}
      </div>
    </div>
  );
}
