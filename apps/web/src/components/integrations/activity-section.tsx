'use client';

import { ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { relativeTime } from '@/lib/when';
import { ACTIVITY_LIMIT } from '@/lib/integrations';
import type { ActivityDto } from '@/server/integrations-data';
import { useHouseholdFormat } from '../household-format';
import { EmptyCard, LoadError, SectionHeader } from './shared';

const TITLE_ID = 'activity-title';
const DAY_MS = 86_400_000;
const KNOWN_ACTIONS = new Set([
  'pat_create',
  'pat_revoke',
  'consent_revoke',
  'transaction_create',
  'transaction_categorise',
  'rule_create',
  'asset_valuation',
  'account_delete',
]);

/** Recent activity (owners only): the last 50 audit rows in words, newest first. */
export function ActivitySection({
  activity,
  now,
}: {
  /** Null when the log could not be loaded. */
  activity: ActivityDto[] | null;
  now: string;
}) {
  const t = useTranslations('integrations.activity');
  const root = useTranslations('integrations');
  const { locale, timeZone } = useHouseholdFormat();
  const nowDate = new Date(now);

  /** Relative within a day ("há 2 h"), then the date and time ("14 out., 10:32"). */
  function when(iso: string): string {
    const at = new Date(iso);
    if (Math.abs(at.getTime() - nowDate.getTime()) < DAY_MS) {
      return relativeTime(iso, nowDate, locale, root('justNow'));
    }
    const date = new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      timeZone,
    }).format(at);
    const time = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    }).format(at);
    return `${date}, ${time}`;
  }

  if (activity === null) {
    return <LoadError id={TITLE_ID} title={t('title')} help={t('help')} message={t('loadError')} />;
  }
  if (activity.length === 0) {
    return (
      <section aria-labelledby={TITLE_ID} className="grid grid-cols-1 gap-3">
        <SectionHeader id={TITLE_ID} title={t('title')} help={t('help')} />
        <EmptyCard icon={<ShieldCheck className="size-6" />}>{t('empty')}</EmptyCard>
      </section>
    );
  }
  return (
    <section aria-labelledby={TITLE_ID} className="grid grid-cols-1 gap-3">
      <SectionHeader id={TITLE_ID} title={t('title')} help={t('help')} />
      <ol
        data-testid="activity-list"
        className="divide-y divide-border overflow-hidden rounded-lg bg-surface shadow-card"
      >
        {activity.map((row) => {
          const key = row.action.replace(/\./g, '_');
          const label = KNOWN_ACTIONS.has(key)
            ? t(`action.${key}` as never)
            : t('action.unknown', { action: row.action });
          const via =
            row.via.kind === 'token'
              ? row.via.name
                ? t('viaToken', { name: row.via.name })
                : t('viaTokenGone')
              : row.via.kind === 'app'
                ? t('viaApp', { client: row.via.client })
                : t('viaWeb');
          return (
            <li key={row.id} className="min-h-14 px-4 py-2">
              <p className="break-words text-base font-medium">{label}</p>
              <p className="text-sm text-muted-foreground">
                {row.who ?? t('deletedUser')}
                {' · '}
                {via}
                {' · '}
                <time dateTime={row.at}>{when(row.at)}</time>
              </p>
            </li>
          );
        })}
      </ol>
      {activity.length >= ACTIVITY_LIMIT ? (
        <p className="text-sm text-muted-foreground">{t('limit')}</p>
      ) : null}
    </section>
  );
}
