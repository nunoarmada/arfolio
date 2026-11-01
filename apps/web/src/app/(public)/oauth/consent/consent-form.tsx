'use client';

import { Check, Minus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { oauthRedirectUrl } from '@/lib/oauth-continue';
import { useHydrated } from '@/lib/use-hydrated';

const IDENTITY_SCOPES = ['openid', 'profile', 'email'];

type Labels = {
  heading: string;
  'pfm:read'?: string;
  'pfm:write'?: string;
  identity?: string;
  offline_access?: string;
  unavailable?: string;
  grantedSr?: string;
};

type Problem = 'network' | 'generic' | 'stale' | null;

/**
 * Allow / Deny. The page's CSP limits `form-action` to this origin, and the browser would apply
 * that to the redirect back to the MCP client too, so nothing is submitted natively: the consent
 * endpoint is called with fetch and the browser is then sent to the client's callback with
 * `location.assign` (navigation is not subject to form-action). `method="post"` plus the
 * hydration guard keep an early Enter press from ever submitting a GET.
 */
export function ConsentForm({
  scopes,
  grant,
  labels,
  denyOnly = false,
}: {
  scopes: string[];
  /** The requested scopes this user's role may grant. */
  grant: string[];
  labels: Labels;
  denyOnly?: boolean;
}) {
  const t = useTranslations('oauthConsent');
  const hydrated = useHydrated();
  const [pending, setPending] = useState<'allow' | 'deny' | null>(null);
  const [problem, setProblem] = useState<Problem>(null);

  async function decide(accept: boolean) {
    if (pending) return;
    setPending(accept ? 'allow' : 'deny');
    setProblem(null);
    try {
      const { data, error } = await authClient.oauth2.consent({
        accept,
        // Only what the role may grant is sent; the server narrows it again.
        ...(accept ? { scope: grant.join(' ') } : {}),
      });
      const url = oauthRedirectUrl(data);
      if (error || !url) {
        setProblem(
          error?.code === 'SESSION_NOT_FRESH' ? 'stale' : error?.status ? 'generic' : 'network',
        );
        setPending(null);
        return;
      }
      window.location.assign(url);
    } catch {
      setProblem('network');
      setPending(null);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!denyOnly) void decide(true);
  }

  const has = (scope: string) => scopes.includes(scope);
  const rows: { key: string; label: string | undefined; available: boolean }[] = [
    { key: 'pfm:read', label: labels['pfm:read'], available: grant.includes('pfm:read') },
    { key: 'pfm:write', label: labels['pfm:write'], available: grant.includes('pfm:write') },
  ].filter((row) => has(row.key));
  if (IDENTITY_SCOPES.some(has)) {
    rows.push({ key: 'identity', label: labels.identity, available: true });
  }
  if (has('offline_access')) {
    rows.push({ key: 'offline_access', label: labels.offline_access, available: true });
  }

  return (
    <form method="post" onSubmit={onSubmit} className="mt-5 grid grid-cols-1 gap-4">
      {problem ? <Alert tone="error">{t(problem)}</Alert> : null}

      {rows.length > 0 ? (
        <section aria-labelledby="consent-scopes" className="rounded-md bg-surface-2 p-4">
          <h2 id="consent-scopes" className="text-card-title mb-3">
            {labels.heading}
          </h2>
          <ul className="grid grid-cols-1 gap-2">
            {rows.map((row) => (
              <li key={row.key} className="flex items-start gap-3 text-sm">
                {row.available ? (
                  <Check className="mt-1 size-4 shrink-0 text-positive" aria-hidden="true" />
                ) : (
                  <Minus
                    className="mt-1 size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
                <span className={row.available ? undefined : 'text-muted-foreground'}>
                  {row.available ? <span className="sr-only">{labels.grantedSr} </span> : null}
                  {row.label}
                  {row.available ? null : (
                    <span className="block text-sm">{labels.unavailable}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="flex flex-col-reverse gap-3 sm:grid sm:grid-cols-2">
        <Button
          variant="outline"
          size="lg"
          disabled={!hydrated}
          loading={pending === 'deny'}
          onClick={() => void decide(false)}
        >
          {t('deny')}
        </Button>
        {denyOnly ? null : (
          <Button type="submit" size="lg" disabled={!hydrated} loading={pending === 'allow'}>
            {pending === 'allow' ? t('allowing') : t('allow')}
          </Button>
        )}
      </div>
      {denyOnly ? null : <p className="text-sm text-muted-foreground">{t('revokeHint')}</p>}
    </form>
  );
}
