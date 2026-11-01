'use client';

import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useId } from 'react';
import { Monogram } from '@/components/account-badge';
import { Alert } from '@/components/ui/alert';
import { StatusChip } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useHouseholdFormat } from '@/components/household-format';
import {
  consentLine,
  errorText,
  lastSyncedLine,
  manualHelper,
  nextSyncLine,
  statusLabel,
  type ConnectionsT,
} from '@/lib/connection-copy';
import { cn } from '@/lib/cn';
import { connectionStatus, isBlocking } from '@/lib/connection-status';
import type { ConnectionDto } from '@/server/serialize';
import { StatusGlyph } from './sync-status';

const CHIP_TONE = {
  muted: 'neutral',
  positive: 'positive',
  warning: 'warning',
  negative: 'negative',
} as const;

const MAX_ACCOUNT_NAMES = 3;
const WARNING_CODES = new Set([
  'rate_limited',
  'unavailable',
  'bad_response',
  'rejected',
  'skipped_rows',
  'history_incomplete',
]);

/**
 * One connection: who, status (icon and word), the accounts it feeds, when it last and next
 * syncs, how long bank access lasts, and the actions that fit its state.
 */
export function ConnectionCard({
  connection: c,
  now,
  canWrite,
  bankingEnabled,
  canConfigure = false,
  syncing,
  inlineError,
  onSync,
  onRemove,
}: {
  connection: ConnectionDto;
  now: Date;
  canWrite: boolean;
  bankingEnabled: boolean;
  /** The viewer is the household owner and can set up Enable Banking in Settings > Services. */
  canConfigure?: boolean;
  syncing: boolean;
  /** A sync that failed just now (the error text for its code), shown in the card. */
  inlineError: string | null;
  onSync: () => void;
  onRemove: () => void;
}) {
  const t = useTranslations('connections');
  const tt = t as unknown as ConnectionsT;
  const { locale, timeZone } = useHouseholdFormat();
  const cx = { now, locale, timeZone };
  const titleId = useId();
  const helperId = useId();

  const status = connectionStatus(c, now, timeZone, syncing);
  const label = statusLabel(tt, status, c.lastSuccessAt, cx);
  const blocking = isBlocking(connectionStatus(c, now, timeZone).key);
  const isBank = c.provider === 'enablebanking';
  const name = c.displayName;

  const names = c.accounts.map((a) => a.name);
  const accountsLine =
    names.length === 0
      ? t('accountsNone')
      : names.slice(0, MAX_ACCOUNT_NAMES).join(' · ') +
        (names.length > MAX_ACCOUNT_NAMES
          ? ` ${t('accountsMore', { count: names.length - MAX_ACCOUNT_NAMES })}`
          : '');

  const last = lastSyncedLine(tt, c.lastSuccessAt, cx);
  const consent = consentLine(tt, c, cx);
  const showNext = c.status === 'active' && c.nextSyncAt !== null;

  // The problem line: a failure from just now wins, then the stored code (or the expiry itself).
  const code =
    c.lastErrorCode ??
    (c.status === 'expired' || status.key === 'expired' ? 'consent_expired' : null);
  const problem = inlineError ?? (code !== null ? errorText(tt, code, c.provider) : null);
  const problemTone = code !== null && WARNING_CODES.has(code) ? 'warning' : 'error';

  const sync = c.manualRefresh;
  const syncBlocked = sync.remaining === 0 || (isBank && !bankingEnabled);
  const helper = isBank && !bankingEnabled ? t('helper.bankingDisabled') : manualHelper(tt, c, cx);
  const canSync = c.status === 'active' && !blocking;
  // Banks share several accounts per consent; a Trading 212 key gives exactly one.
  const canManage = isBank && bankingEnabled && (c.status === 'active' || c.status === 'error');
  const showRenew = (blocking || status.key === 'expiring') && (isBank ? bankingEnabled : true);
  const renewHref = isBank
    ? `/connections/new/bank/authorise?connection=${c.id}`
    : `/connections/new/trading212?connection=${c.id}`;
  const renewLabel = isBank ? t('action.renew') : t('action.updateKey');

  return (
    <Card
      as="article"
      id={`conn-${c.id}`}
      aria-labelledby={titleId}
      className="grid h-full scroll-mt-20 grid-cols-1 content-start gap-4"
    >
      <div className="flex items-start gap-3">
        <Monogram name={c.institutionName ?? name} className="size-10 text-sm" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <h2
            id={titleId}
            tabIndex={-1}
            data-conn-title={c.id}
            className="min-w-0 flex-1 basis-40 truncate text-card-title outline-none"
          >
            {name}
          </h2>
          <StatusChip
            tone={CHIP_TONE[status.tone]}
            icon={
              <StatusGlyph
                icon={status.icon}
                tone={status.tone}
                className="size-3.5 text-current"
              />
            }
            className="shrink-0"
          >
            {label}
          </StatusChip>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">{accountsLine}</p>

      <dl className="grid grid-cols-1 gap-3 rounded-md bg-surface-2 p-3 text-sm sm:grid-cols-3 sm:gap-4">
        <div className="grid grid-cols-1 gap-0.5">
          <dt className="text-label text-muted-foreground">{t('meta.lastSynced')}</dt>
          <dd>
            {last.iso ? (
              <time dateTime={last.iso} title={last.title} className="whitespace-nowrap">
                {last.text}
              </time>
            ) : (
              last.text
            )}
          </dd>
        </div>
        {showNext ? (
          <div className="grid grid-cols-1 gap-0.5">
            <dt className="text-label text-muted-foreground">{t('meta.nextSync')}</dt>
            <dd>
              <time dateTime={c.nextSyncAt!} className="whitespace-nowrap">
                {nextSyncLine(tt, c.nextSyncAt!, cx)}
              </time>
            </dd>
          </div>
        ) : null}
        {consent ? (
          <div className="grid grid-cols-1 gap-0.5">
            <dt className="text-label text-muted-foreground">
              {isBank ? t('meta.bankAccess') : t('meta.access')}
            </dt>
            <dd
              className={cn(
                'flex items-center gap-1.5',
                consent.tone === 'warning' && 'font-medium text-warning',
                consent.tone === 'negative' && 'font-medium text-negative',
              )}
            >
              {consent.tone === 'warning' ? (
                <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              ) : null}
              {consent.text}
            </dd>
          </div>
        ) : null}
      </dl>

      {problem ? <Alert tone={problemTone}>{problem}</Alert> : null}

      {canWrite ? (
        <div className="mt-auto grid grid-cols-1 gap-2 border-t border-border pt-4 md:flex md:items-start md:justify-end">
          <div className="flex flex-wrap gap-2 md:justify-end">
            {c.status === 'pending' ? (
              <Link
                href={`/connections/${c.id}/link`}
                className={cn(buttonVariants(), 'max-md:flex-1')}
              >
                {t('action.linkAccounts')}
              </Link>
            ) : null}
            {canManage ? (
              <Link
                href={`/connections/${c.id}/link`}
                aria-label={t('action.manageAccountsLabel', { name })}
                className={cn(buttonVariants({ variant: 'outline' }), 'max-md:flex-1')}
              >
                {t('action.manageAccounts')}
              </Link>
            ) : null}
            {showRenew ? (
              <Link href={renewHref} className={cn(buttonVariants(), 'max-md:flex-1')}>
                {renewLabel}
              </Link>
            ) : null}
            {canSync ? (
              <div className="grid grid-cols-1 gap-1 max-md:w-full md:justify-items-end">
                <Button
                  variant="outline"
                  loading={syncing}
                  aria-disabled={syncBlocked || undefined}
                  aria-describedby={helperId}
                  className={cn(
                    'max-md:w-full',
                    syncBlocked && 'cursor-not-allowed opacity-60 hover:bg-surface',
                  )}
                  onClick={() => {
                    if (!syncBlocked) onSync();
                  }}
                >
                  {syncing ? t('action.syncing') : t('action.syncNow')}
                </Button>
                <p id={helperId} className="text-sm text-muted-foreground">
                  {helper}
                  {isBank && !bankingEnabled && canConfigure ? (
                    <>
                      {' '}
                      <Link
                        href="/settings/services#bank"
                        className="inline-flex min-h-11 items-center text-primary-text underline-offset-4 hover:underline"
                      >
                        {t('helper.configureLink')}
                      </Link>
                    </>
                  ) : null}
                </p>
              </div>
            ) : null}
            <Button
              variant="ghost"
              aria-label={t('action.removeLabel', { name })}
              className="max-md:w-full"
              onClick={onRemove}
            >
              {t('action.remove')}
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
