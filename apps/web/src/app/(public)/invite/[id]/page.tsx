import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { Metadata } from 'next';
import { AuthShell } from '@/components/auth-shell';
import { Alert } from '@/components/ui/alert';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@/lib/credentials';
import { getInvitationPreview } from '@/server/invitations';
import { InviteForm } from './invite-form';

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: (await getTranslations('invite'))('title'),
    // The URL carries a secret: never leak it through Referer (proxy.ts also sends the header).
    referrer: 'no-referrer',
  };
}

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string | string[] }>;
}) {
  const [{ id }, query, t] = await Promise.all([params, searchParams, getTranslations('invite')]);
  const token = Array.isArray(query.t) ? query.t[0] : query.t;
  // Expired, revoked, used and wrongly-tokened links all look the same.
  const preview = token ? await getInvitationPreview(id, token) : null;
  const roles = await getTranslations('roles');

  if (!preview || !token) {
    return (
      <AuthShell>
        <h1 className="mb-3 text-title">{t('invalidTitle')}</h1>
        <Alert tone="info">{t('invalidBody')}</Alert>
        <Link
          href="/sign-in"
          className="mt-4 inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4"
        >
          {t('goToSignIn')}
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1 className="mb-2 text-title">{t('title')}</h1>
      <p className="text-base">
        {t.rich('summary', {
          strong: (chunks) => <strong>{chunks}</strong>,
          inviter: preview.inviterName,
          household: preview.householdName,
          role: roles(preview.role).toLowerCase(),
        })}
      </p>
      <p className="mb-5 mt-1 text-sm text-muted-foreground">{roles(`${preview.role}Help`)}</p>
      <InviteForm
        invitationId={id}
        token={token}
        email={preview.email}
        passwordBounds={{ min: MIN_PASSWORD_LENGTH, max: MAX_PASSWORD_LENGTH }}
      />
    </AuthShell>
  );
}
