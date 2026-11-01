import { eq } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { schema } from '@arfolio/db';
import { AuthShell } from '@/components/auth-shell';
import { Alert } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { SignOutButton } from '@/components/sign-out-button';
import { cn } from '@/lib/cn';
import { getAuth } from '@/lib/auth';
import { getBrand } from '@/lib/brand';
import { getDb } from '@/lib/db';
import { isFreshSession } from '@/lib/fresh-session';
import { grantableScopes, resolveMcpHousehold } from '@/lib/mcp-consent';
import { ConsentForm } from './consent-form';

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: (await getTranslations('oauthConsent'))('title'),
    // The query carries a signed authorization request: keep it out of Referer.
    referrer: 'no-referrer',
  };
}

type Query = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** The redirect URI's host, or null when it is not a URL at all. */
function hostOf(uri: string | undefined): string | null {
  try {
    return uri ? new URL(uri).host : null;
  } catch {
    return null;
  }
}

/**
 * Consent for an OAuth authorization request from an MCP client. The provider sends the browser
 * here with a signed query (client_id, scope, redirect_uri, ...); allowing or denying calls the
 * provider's consent endpoint from the browser (the form never submits natively, see
 * consent-form.tsx), which re-checks the signature, the household and the role.
 */
export default async function OAuthConsentPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const t = await getTranslations('oauthConsent');

  const requestHeaders = await headers();
  const current = await getAuth().api.getSession({ headers: requestHeaders });
  if (!current) {
    // Not signed in (session expired in between): sign in, then continue the authorization.
    const carried = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
        carried.append(key, v);
      }
    }
    redirect(`/sign-in?${carried}`);
  }

  const db = getDb();
  const clientId = first(query.client_id);
  const [client] = clientId
    ? await db
        .select({ name: schema.oauthClient.name, redirectUris: schema.oauthClient.redirectUris })
        .from(schema.oauthClient)
        .where(eq(schema.oauthClient.clientId, clientId))
    : [];
  const redirectUri = first(query.redirect_uri);
  const host = hostOf(redirectUri);
  // The request must name a registered client and one of its own callbacks.
  if (!client || !host || !redirectUri || !client.redirectUris.includes(redirectUri)) {
    return (
      <AuthShell>
        <h1 className="mb-3 text-title">{t('invalidTitle')}</h1>
        <Alert tone="error">{t('invalidBody')}</Alert>
        <Link href="/" className={cn(buttonVariants({ variant: 'link' }), 'mt-3')}>
          {t('home')}
        </Link>
      </AuthShell>
    );
  }

  const household = await resolveMcpHousehold(db, current.user.id);
  if (
    household.kind === 'resolved' &&
    household.role === 'owner' &&
    !current.user.twoFactorEnabled
  ) {
    redirect('/two-factor/setup'); // same rule as the rest of the app: owners need 2FA first
  }

  if (!isFreshSession(current.session.createdAt)) {
    // Granting access needs a recent sign-in (the consent endpoint enforces it too).
    return (
      <AuthShell>
        <h1 className="mb-3 text-title">{t('title')}</h1>
        <Alert tone="warning">{t('stale')}</Alert>
        <SignOutButton className="mt-3" />
      </AuthShell>
    );
  }

  const brand = getBrand();
  const clientName = client.name?.trim() || host;
  const requested = (first(query.scope) ?? '').split(' ').filter(Boolean);
  const canGrant = household.kind === 'resolved' ? grantableScopes(requested, household.role) : [];

  return (
    <AuthShell width="md">
      <h1 className="mb-2 text-title">{t('title')}</h1>
      <p className="text-base">
        {t.rich('summary', {
          strong: (chunks) => <strong>{chunks}</strong>,
          client: clientName,
          brand: brand.name,
        })}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {t.rich('returnsTo', {
          host: (chunks) => <span className="break-all font-medium">{chunks}</span>,
          address: host,
        })}
      </p>

      {household.kind === 'resolved' ? (
        <>
          <p className="mt-5 text-base">
            {t.rich('household', {
              strong: (chunks) => <strong>{chunks}</strong>,
              household: household.name,
            })}
          </p>
          <ConsentForm
            scopes={requested}
            grant={canGrant}
            labels={{
              heading: t('scopesHeading'),
              'pfm:read': t('scope.read'),
              'pfm:write': t('scope.write'),
              identity: t('scope.identity'),
              offline_access: t('scope.offline'),
              unavailable: t('writeUnavailable'),
              grantedSr: t('grantedSr'),
            }}
          />
        </>
      ) : (
        <>
          <Alert tone="warning" className="mt-5">
            {t('unresolved')}
          </Alert>
          <ConsentForm scopes={[]} grant={[]} labels={{ heading: '' }} denyOnly />
        </>
      )}
    </AuthShell>
  );
}
