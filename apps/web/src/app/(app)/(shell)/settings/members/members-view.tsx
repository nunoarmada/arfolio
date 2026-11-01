'use client';

import { MailOpen, Trash2, UserPlus, Users } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useActionState, useEffect, useState, useTransition } from 'react';
import { CopyButton } from '@/components/copy-button';
import { Alert } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { SettingsCard } from '@/components/settings/settings-card';
import { Field, Input } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { ROLES, type Role } from '@/lib/access';
import type { MemberRow, PendingInvitationRow } from '@/server/members';
import {
  inviteAction,
  removeMemberAction,
  revokeInvitationAction,
  type ActionResult,
  type InviteState,
} from './actions';

export function MembersView({
  members,
  pending,
  isOwner,
}: {
  members: MemberRow[];
  pending: PendingInvitationRow[];
  isOwner: boolean;
}) {
  const t = useTranslations('members');
  const roles = useTranslations('roles');
  const common = useTranslations('common');
  const toast = useToast();
  const format = useFormatter();
  const [busy, startTransition] = useTransition();
  const [invite, inviteFormAction, inviting] = useActionState<InviteState, FormData>(inviteAction, {
    status: 'idle',
    at: 0,
  });
  const [role, setRole] = useState<Role>('member');
  const [shownAt, setShownAt] = useState(0);
  // A new invitation replaces the previous link; closing hides it for good.
  const linkVisible = invite.status === 'created' && invite.at !== shownAt;

  function report(result: ActionResult, success: string) {
    if (result.ok) toast.success(success);
    else toast.error(result.reason === 'forbidden' ? t('errorForbidden') : t('errorAction'));
  }

  // Reset the form's email field after a successful invitation.
  const [formKey, setFormKey] = useState(0);
  useEffect(() => {
    if (invite.status === 'created') setFormKey((k) => k + 1);
  }, [invite.status, invite.at]);

  return (
    <div className="grid grid-cols-1 gap-4 md:gap-5">
      <SettingsCard
        titleId="members-list"
        title={t('listTitle')}
        description={!isOwner ? t('viewerNote') : undefined}
        icon={Users}
        flush
      >
        <ul className="divide-y divide-border">
          {members.map((m) => (
            <li
              key={m.memberId}
              className="flex min-h-16 items-center gap-3 px-4 py-2 md:px-5 xl:px-6"
            >
              <span
                aria-hidden="true"
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary-text"
              >
                {Array.from(m.name)[0]?.toUpperCase() ?? '?'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-base font-medium">{m.name}</span>
                  {m.isSelf ? (
                    <span className="shrink-0 rounded-sm bg-surface-3 px-1.5 py-0.5 text-caption">
                      {common('you')}
                    </span>
                  ) : null}
                </span>
                <span className="block truncate text-sm text-muted-foreground">{m.email}</span>
              </span>
              <span className="shrink-0 rounded-full bg-surface-2 px-2.5 py-0.5 text-caption text-muted-foreground">
                {roles(m.role)}
              </span>
              {isOwner && !m.isSelf ? (
                <ConfirmDialog
                  trigger={
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('removeLabel', { name: m.name })}
                    >
                      <Trash2 className="size-5" aria-hidden="true" />
                    </Button>
                  }
                  title={t('removeTitle', { name: m.name })}
                  description={t('removeBody', { name: m.name })}
                  confirmLabel={t('removeConfirm')}
                  cancelLabel={common('cancel')}
                  pending={busy}
                  onConfirm={() =>
                    startTransition(async () =>
                      report(await removeMemberAction(m.memberId), t('removed')),
                    )
                  }
                />
              ) : null}
            </li>
          ))}
        </ul>
      </SettingsCard>

      {isOwner ? (
        <>
          <SettingsCard titleId="invite-title" title={t('inviteTitle')} icon={UserPlus}>
            {invite.status === 'invalid' ? <Alert tone="error">{t('errorInvite')}</Alert> : null}
            {invite.status === 'error' ? <Alert tone="error">{t('errorAction')}</Alert> : null}
            {invite.status === 'forbidden' ? (
              <Alert tone="error">{t('errorForbidden')}</Alert>
            ) : null}

            {linkVisible && invite.link ? (
              <Alert
                tone="success"
                title={t('linkTitle')}
                action={
                  <div className="flex flex-wrap items-center gap-2">
                    <CopyButton
                      text={invite.link}
                      label={t('copyLink')}
                      copiedLabel={t('linkCopied')}
                    />
                    <Button variant="ghost" onClick={() => setShownAt(invite.at)}>
                      {t('dismiss')}
                    </Button>
                  </div>
                }
              >
                <p>
                  {t(invite.emailed ? 'linkIntroEmailed' : 'linkIntro', {
                    email: invite.email ?? '',
                  })}
                  {invite.emailed ? null : (
                    <>
                      {' '}
                      <Link
                        href="/settings/services#email"
                        className="inline-flex min-h-11 items-center text-primary-text underline-offset-4 hover:underline"
                      >
                        {t('emailSetupLink')}
                      </Link>
                    </>
                  )}
                </p>
                <label htmlFor="invite-link" className="mt-2 block text-sm font-medium">
                  {t('linkLabel')}
                </label>
                <input
                  id="invite-link"
                  readOnly
                  value={invite.link}
                  onFocus={(e) => e.currentTarget.select()}
                  className="mt-1 h-11 w-full rounded-md border border-input bg-surface px-3 text-sm"
                />
              </Alert>
            ) : null}

            <form key={formKey} action={inviteFormAction} className="grid grid-cols-1 gap-4">
              <Field label={t('email')}>
                {(p) => <Input {...p} name="email" type="email" autoComplete="off" required />}
              </Field>
              <Field label={t('role')} hint={roles(`${role}Help`)}>
                {(p) => (
                  <Select
                    {...p}
                    name="role"
                    value={role}
                    onChange={(e) => setRole(e.target.value as Role)}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {roles(r)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Button type="submit" loading={inviting} className="justify-self-start">
                {inviting ? t('creating') : t('createInvite')}
              </Button>
            </form>
          </SettingsCard>

          <SettingsCard
            titleId="pending-title"
            title={t('pendingTitle')}
            icon={MailOpen}
            flush={pending.length > 0}
          >
            {pending.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('pendingEmpty')}</p>
            ) : (
              <ul className="divide-y divide-border">
                {pending.map((inv) => (
                  <li
                    key={inv.id}
                    className="flex min-h-16 items-center gap-3 px-4 py-2 md:px-5 xl:px-6"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base font-medium">{inv.email}</span>
                      <span className="block text-sm text-muted-foreground">
                        {roles(inv.role)} ·{' '}
                        {t('expires', {
                          date: format.dateTime(inv.expiresAt, { dateStyle: 'medium' }),
                        })}
                      </span>
                    </span>
                    <ConfirmDialog
                      trigger={<Button variant="outline">{t('revoke')}</Button>}
                      title={t('revokeTitle')}
                      description={t('revokeBody', { email: inv.email })}
                      confirmLabel={t('revokeConfirm')}
                      cancelLabel={common('cancel')}
                      pending={busy}
                      onConfirm={() =>
                        startTransition(async () =>
                          report(await revokeInvitationAction(inv.id), t('revoked')),
                        )
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </SettingsCard>
        </>
      ) : null}
    </div>
  );
}
