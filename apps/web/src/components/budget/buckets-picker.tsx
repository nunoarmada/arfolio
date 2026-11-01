'use client';

import { useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import { truncateName } from '@/lib/budget-import-copy';
import { cn } from '@/lib/cn';
import type { BucketOption } from '@/server/budget-data';

/**
 * The Trading 212 pies of an investment account a saving line counts. Pies another line of the
 * budget already counts stay focusable but cannot be ticked: the row says which line has them.
 */
export function BucketsPicker({
  options,
  selected,
  takenBy,
  onChange,
}: {
  options: BucketOption[];
  selected: string[];
  /** Bucket id → name of the other line that counts it. */
  takenBy: ReadonlyMap<string, string>;
  onChange: (bucketIds: string[]) => void;
}) {
  const t = useTranslations('budgetLine.buckets');
  const picker = useTranslations('budgetLine.picker');
  const id = useId();
  const hintId = `${id}-hint`;
  const [blocked, setBlocked] = useState('');

  // A pie that was removed stays listed only while the line still counts it.
  const rows = useMemo(() => {
    const linked = new Set(selected);
    return options.filter((o) => !o.removed || linked.has(o.id));
  }, [options, selected]);

  const chosen = new Set(selected);
  function toggle(bucket: string) {
    onChange(chosen.has(bucket) ? selected.filter((s) => s !== bucket) : [...selected, bucket]);
  }

  return (
    <fieldset className="mt-2 grid grid-cols-1 gap-2" aria-describedby={hintId}>
      <legend className="text-sm font-medium">{t('legend')}</legend>
      {rows.length === 0 ? (
        <p id={hintId} className="text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <>
          <p id={hintId} className="text-sm text-muted-foreground">
            {t('hint')}
          </p>
          <ul className="grid grid-cols-1 gap-1">
            {rows.map((o) => {
              const owner = takenBy.get(o.id);
              const checked = chosen.has(o.id);
              const label = o.removed ? t('removed', { name: o.name }) : o.name;
              const reasonId = owner ? `${id}-taken-${o.id}` : undefined;
              return (
                <li key={o.id}>
                  <label
                    className={cn(
                      'flex min-h-12 items-center gap-3 rounded-md border border-transparent px-2 py-1 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring',
                      owner
                        ? 'cursor-not-allowed text-muted-foreground'
                        : 'cursor-pointer hover:bg-surface-2',
                      checked && 'border-primary bg-primary-soft',
                    )}
                  >
                    <input
                      type="checkbox"
                      name="bucketIds"
                      value={o.id}
                      checked={checked}
                      aria-disabled={owner ? true : undefined}
                      aria-describedby={reasonId}
                      onChange={() => {
                        // A pie another line counts cannot be ticked: say why instead.
                        if (owner) {
                          setBlocked(t('moveHint', { line: truncateName(owner) }));
                          return;
                        }
                        setBlocked('');
                        toggle(o.id);
                      }}
                      onClick={(e) => {
                        if (owner) e.preventDefault();
                      }}
                      className="size-5 shrink-0 accent-[var(--primary)]"
                    />
                    <span className="grid min-w-0 flex-1">
                      <span className="break-words text-base">{label}</span>
                      {owner ? (
                        <span id={reasonId} className="text-sm text-muted-foreground">
                          {picker('alreadyIn', { line: truncateName(owner) })}
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p role="status" className="min-h-5 text-sm font-medium text-warning">
        {blocked}
      </p>
    </fieldset>
  );
}
