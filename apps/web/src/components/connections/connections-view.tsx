'use client';

import { Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EmptyState } from '@/components/empty-state';
import { useHouseholdFormat } from '@/components/household-format';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { ToneCard } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { useFailureMessage } from '@/components/use-action-error';
import { atLabels, errorText, type ConnectionsT } from '@/lib/connection-copy';
import {
  connectionStatus,
  isBlocking,
  needsAttention,
  sortConnections,
} from '@/lib/connection-status';
import { relativeTime, dayTime, zonedDate } from '@/lib/when';
import { removeConnectionAction, syncNowAction } from '@/server/actions/connections';
import type { ResultCode } from '@/server/consent-callback';
import type { ConnectionDto } from '@/server/serialize';
import { ConnectionCard } from './connection-card';
import { RemoveConnectionDialog } from './remove-connection-dialog';
import { PageContainer } from '@/components/page-container';

const POLL_MS = 15_000;
const POLL_MAX_MS = 10 * 60_000;

/** The outcome of the consent or link step, resolved on the server from `?result=&id=`. */
export interface ResultNotice {
  code: ResultCode;
  /**
   * linked: how many accounts; accounts_updated: the connection and how many accounts sync now;
   * renewed: the bank and the new end date (ISO).
   */
  count?: number;
  name?: string;
  expiresAt?: string | null;
}

const NOTICE_TONE: Record<ResultCode, 'success' | 'info' | 'warning' | 'error'> = {
  linked: 'success',
  renewed: 'success',
  cancelled: 'info',
  state_expired: 'warning',
  state_used: 'info',
  state_invalid: 'error',
  provider_error: 'error',
  connection_gone: 'info',
  not_configured: 'error',
  misconfigured: 'error',
  sync_in_progress: 'warning',
  key_updated: 'success',
  accounts_updated: 'success',
};
const RETRYABLE = new Set<ResultCode>([
  'state_expired',
  'state_used',
  'state_invalid',
  'provider_error',
  'cancelled',
]);

function noticeText(t: ConnectionsT, n: ResultNotice, locale: string, timeZone: string): string {
  if (n.code === 'linked') return t('result.linked', { count: n.count ?? 0 });
  if (n.code === 'accounts_updated') {
    return t('result.accounts_updated', { name: n.name ?? '', count: n.count ?? 0 });
  }
  if (n.code === 'renewed') {
    const name = n.name ?? '';
    if (!n.expiresAt) return t('result.renewedNoDate', { name });
    const date = zonedDate(n.expiresAt, locale, timeZone);
    return t('result.renewed', { name, date });
  }
  if (n.code === 'key_updated') return t('result.key_updated', { name: n.name ?? '' });
  return t(`result.${n.code}`);
}

export function ConnectionsView({
  connections,
  nowIso,
  canWrite,
  bankingEnabled,
  canConfigure = false,
  notice: initialNotice,
  tabs,
}: {
  connections: ConnectionDto[];
  nowIso: string;
  canWrite: boolean;
  bankingEnabled: boolean;
  /** The viewer is the household owner, who can set up bank connections in Settings > Services. */
  canConfigure?: boolean;
  notice: ResultNotice | null;
  /** The Contas/Ligações tabs, drawn in the page header. */
  tabs?: ReactNode;
}) {
  const t = useTranslations('connections');
  const tt = t as unknown as ConnectionsT;
  const common = useTranslations('common');
  const router = useRouter();
  const toast = useToast();
  const failure = useFailureMessage();
  const { locale, timeZone } = useHouseholdFormat();
  const now = useMemo(() => new Date(nowIso), [nowIso]);

  const [notice, setNotice] = useState<ResultNotice | null>(initialNotice);
  const [syncing, setSyncing] = useState<Set<string>>(new Set());
  const [inline, setInline] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [announcement, setAnnouncement] = useState('');
  const [removing, setRemoving] = useState<ConnectionDto | null>(null);
  const [removePending, setRemovePending] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  // Show the outcome once: focus it, then strip the parameters so a reload does not repeat it.
  useEffect(() => {
    if (initialNotice) {
      setNotice(initialNotice);
      noticeRef.current?.focus();
      router.replace('/connections', { scroll: false });
    }
  }, [initialNotice, router]);

  const visible = useMemo(
    () => connections.filter((c) => !removed.has(c.id)),
    [connections, removed],
  );
  const statusOf = useCallback(
    (c: ConnectionDto) => connectionStatus(c, now, timeZone).key,
    [now, timeZone],
  );
  const sorted = useMemo(() => sortConnections(visible, statusOf), [visible, statusOf]);
  const problems = visible.filter((c) => needsAttention(statusOf(c))).length;
  const blockingCount = visible.filter((c) => isBlocking(statusOf(c))).length;
  const active = visible.filter((c) => c.status === 'active');
  const newest = active
    .map((c) => c.lastSuccessAt)
    .filter((v): v is string => v !== null)
    .sort()
    .at(-1);

  // Waiting for the first sync: look again every 15 s for up to 10 minutes, and say when it lands.
  const waiting = visible.filter((c) => c.status === 'active' && c.lastSuccessAt === null);
  const waitingKey = waiting.map((c) => c.id).join(',');
  const previousWaiting = useRef<Set<string>>(new Set(waiting.map((c) => c.id)));
  useEffect(() => {
    const done = [...previousWaiting.current].filter((id) =>
      visible.some((c) => c.id === id && c.lastSuccessAt !== null),
    );
    if (done.length > 0) setAnnouncement(t('sync.firstDone'));
    previousWaiting.current = new Set(waiting.map((c) => c.id));
  }, [waitingKey]);
  useEffect(() => {
    if (!waitingKey) return;
    const started = Date.now();
    const id = window.setInterval(() => {
      if (Date.now() - started > POLL_MAX_MS) return window.clearInterval(id);
      router.refresh();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [waitingKey, router]);

  const mark = (id: string, on: boolean) =>
    setSyncing((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  async function sync(c: ConnectionDto) {
    if (syncing.has(c.id)) return;
    mark(c.id, true);
    setInline((cur) => Object.fromEntries(Object.entries(cur).filter(([id]) => id !== c.id)));
    setAnnouncement(t('sync.started', { name: c.displayName }));
    let message = '';
    try {
      const result = await syncNowAction(c.id);
      if (!result.ok) {
        message = result.code === 'forbidden' ? failure(result) : t('sync.failed');
        toast.error(message, { label: common('retry'), onClick: () => void sync(c) });
        return;
      }
      const o = result.data;
      switch (o.kind) {
        case 'synced':
          message = t(o.partial ? 'sync.partial' : 'sync.success', { count: o.inserted });
          if (o.partial) toast.warning(message);
          else toast.success(message);
          break;
        case 'failed':
          message = errorText(tt, o.errorCode, c.provider);
          setInline((cur) => ({ ...cur, [c.id]: message }));
          break;
        case 'locked':
          message = t('sync.locked');
          toast.info(message);
          break;
        case 'limit':
          message = t('sync.limit', {
            when: dayTime(o.retryAt, new Date(), locale, timeZone, atLabels(tt)),
          });
          toast.info(message);
          break;
        case 'not_active':
          message = t('sync.notActive');
          setInline((cur) => ({ ...cur, [c.id]: message }));
          break;
        case 'gone':
          break;
      }
      router.refresh();
    } catch {
      message = t('sync.failed');
      toast.error(message, { label: common('retry'), onClick: () => void sync(c) });
    } finally {
      mark(c.id, false);
    }
  }

  /** After a removal focus moves to the next card's heading, or to the empty-state heading. */
  function focusAfterRemoval(id: string) {
    const index = sorted.findIndex((c) => c.id === id);
    const next = sorted[index + 1] ?? sorted[index - 1];
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const target = next
          ? document.querySelector<HTMLElement>(`[data-conn-title="${next.id}"]`)
          : document.getElementById('connections-empty');
        target?.focus();
      }),
    );
  }

  async function remove(c: ConnectionDto) {
    setRemovePending(true);
    setRemoveError(null);
    try {
      const result = await removeConnectionAction(c.id);
      if (!result.ok) {
        setRemoveError(failure(result));
        return;
      }
      const o = result.data;
      if (o.kind === 'busy') {
        setRemoveError(t('remove.inProgress'));
        return;
      }
      setRemoving(null);
      setRemoved((cur) => new Set(cur).add(c.id));
      focusAfterRemoval(c.id);
      if (o.kind === 'removed' && !o.providerSessionRevoked && c.provider === 'enablebanking') {
        toast.info(
          o.consentExpiresAt
            ? t('remove.notConfirmed', {
                date: zonedDate(o.consentExpiresAt, locale, timeZone),
              })
            : t('remove.notConfirmedNoDate'),
        );
      } else {
        toast.success(t('remove.done'));
      }
      router.refresh();
    } catch {
      setRemoveError(failure({ ok: false, code: 'error' }));
    } finally {
      setRemovePending(false);
    }
  }

  const addAction = canWrite ? (
    <Link
      href="/connections/new"
      aria-label={t('addLabel')}
      className={buttonVariants({ size: 'default', className: 'max-md:size-11 max-md:px-0' })}
    >
      <Plus className="size-5" aria-hidden="true" />
      <span className="max-md:sr-only">{t('add')}</span>
    </Link>
  ) : undefined;

  return (
    <PageContainer>
      <PageHeader title={t('title')} actions={addAction} tabs={tabs} />

      <div className="grid grid-cols-1 gap-4">
        <p className="sr-only" role="status">
          {announcement}
        </p>

        {notice ? (
          <div
            ref={noticeRef}
            tabIndex={-1}
            className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Alert
              tone={NOTICE_TONE[notice.code]}
              action={
                <div className="flex flex-wrap gap-2">
                  {RETRYABLE.has(notice.code) && canWrite ? (
                    <Link
                      href="/connections/new/bank"
                      className={buttonVariants({ variant: 'outline', size: 'sm' })}
                    >
                      {t('result.tryAgain')}
                    </Link>
                  ) : null}
                  <Button variant="ghost" size="sm" onClick={() => setNotice(null)}>
                    <X className="size-4" aria-hidden="true" />
                    {t('result.dismiss')}
                  </Button>
                </div>
              }
            >
              {noticeText(tt, notice, locale, timeZone)}
            </Alert>
          </div>
        ) : null}

        {sorted.length === 0 ? (
          <EmptyState
            title={t('emptyTitle')}
            headingId="connections-empty"
            action={
              canWrite ? (
                <Link href="/connections/new" className={buttonVariants()}>
                  {t('emptyAction')}
                </Link>
              ) : undefined
            }
          >
            {canWrite ? t('emptyBody') : `${t('emptyBody')} ${t('emptyViewer')}`}
          </EmptyState>
        ) : (
          <>
            {problems > 0 ? (
              <ToneCard
                tone={blockingCount > 0 ? 'negative' : 'warning'}
                label={t('summaryProblem', { count: problems })}
              >
                {t('summaryProblem', { count: problems })}
              </ToneCard>
            ) : active.length > 0 ? (
              <p className="text-base text-muted-foreground">
                {newest
                  ? t('summaryOk', {
                      count: active.length,
                      when: relativeTime(newest, now, locale, t('justNow')),
                    })
                  : t('summaryNever', { count: active.length })}
              </p>
            ) : null}
            <ul
              aria-label={t('listLabel')}
              className="grid grid-cols-1 gap-3 md:gap-4 xl:grid-cols-2"
            >
              {sorted.map((c) => (
                <li key={c.id} className="min-w-0">
                  <ConnectionCard
                    connection={c}
                    now={now}
                    canWrite={canWrite}
                    bankingEnabled={bankingEnabled}
                    canConfigure={canConfigure}
                    syncing={syncing.has(c.id)}
                    inlineError={inline[c.id] ?? null}
                    onSync={() => void sync(c)}
                    onRemove={() => {
                      setRemoveError(null);
                      setRemoving(c);
                    }}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {removing ? (
        <RemoveConnectionDialog
          open
          onOpenChange={(open) => !open && !removePending && setRemoving(null)}
          name={removing.displayName}
          provider={removing.provider}
          pending={removePending}
          error={removeError}
          onConfirm={() => void remove(removing)}
        />
      ) : null}
    </PageContainer>
  );
}
