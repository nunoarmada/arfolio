import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { StatusGlyph } from '@/components/connections/sync-status';
import { stripLabel, type ConnectionsT } from '@/lib/connection-copy';
import { connectionStatus } from '@/lib/connection-status';
import { cn } from '@/lib/cn';
import type { ConnectionDto } from '@/server/serialize';

const MAX_ITEMS = 6;

const CHIP: Record<'muted' | 'negative' | 'warning' | 'positive', string> = {
  muted: 'bg-surface-2 text-muted-foreground',
  positive: 'bg-positive-soft text-positive',
  warning: 'bg-warning-soft text-warning',
  negative: 'bg-negative-soft text-negative',
};

/**
 * Home: one sync chip per connection ("Main bank · há 2 h"), each with its status icon. The time and
 * the word never wrap inside a chip (the chips wrap between themselves). The whole strip is one
 * link to the list; its accessible name spells out every connection and state.
 */
export async function ConnectionsStrip({
  connections,
  now,
  locale,
  timeZone,
}: {
  connections: ConnectionDto[];
  now: Date;
  locale: string;
  timeZone: string;
}) {
  if (connections.length === 0) return null;
  const t = (await getTranslations('connections')) as unknown as ConnectionsT;
  const cx = { now, locale, timeZone };
  const items = connections.map((c) => {
    const s = connectionStatus(c, now, timeZone);
    return { c, s, word: stripLabel(t, s.key, c.lastSuccessAt, cx) };
  });
  const shown = items.slice(0, MAX_ITEMS);
  const hidden = items.length - shown.length;
  return (
    <Link
      href="/connections"
      aria-label={t('strip.label', {
        items: items.map((i) => `${i.c.displayName}, ${i.word}`).join('; '),
      })}
      className="-m-1 flex flex-wrap items-center gap-2 rounded-lg p-1 hover:bg-surface-2"
    >
      {shown.map(({ c, s, word }) => (
        <span
          key={c.id}
          title={c.displayName}
          className={cn(
            'inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full px-2.5 text-label',
            CHIP[s.tone],
          )}
        >
          <StatusGlyph icon={s.icon} tone={s.tone} className="size-3.5 text-current" />
          <span className="min-w-0 max-w-40 truncate font-semibold lg:max-w-60">
            {c.displayName}
          </span>
          <span aria-hidden="true" className="opacity-60">
            ·
          </span>
          <span className="shrink-0 whitespace-nowrap font-normal">{word}</span>
        </span>
      ))}
      {hidden > 0 ? (
        <span className="text-label font-normal text-muted-foreground">
          {t('strip.more', { count: hidden })}
        </span>
      ) : null}
    </Link>
  );
}
