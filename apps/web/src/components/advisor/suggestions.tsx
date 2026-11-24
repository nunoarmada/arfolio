'use client';

import { useTranslations } from 'next-intl';
import { filterChipClass } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import type { SuggestionKey } from '@/server/advisor-data';

/** The starter questions as chips; the caller sends the chosen text. */
export function Suggestions({
  keys,
  onPick,
  disabled = false,
  className,
}: {
  keys: SuggestionKey[];
  onPick: (key: SuggestionKey, text: string, trigger: HTMLButtonElement) => void;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations('advisor.suggestions');
  return (
    <div role="group" aria-label={t('label')} className={cn('flex flex-wrap gap-2', className)}>
      {keys.map((key) => (
        <button
          key={key}
          type="button"
          disabled={disabled}
          onClick={(event) => onPick(key, t(key), event.currentTarget)}
          className={cn(
            filterChipClass(false),
            'h-auto min-h-10 min-w-0 max-w-full shrink whitespace-normal py-2 text-left disabled:pointer-events-none disabled:opacity-50 md:h-auto md:min-h-9',
          )}
        >
          {t(key)}
        </button>
      ))}
    </div>
  );
}
