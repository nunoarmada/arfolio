import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';

/**
 * Marks a row the AI categorised ("IA"): text on a neutral chip, never colour alone and never the
 * brand colour. Screen readers get the full sentence.
 */
export function AiBadge({ className }: { className?: string }) {
  const t = useTranslations('ai');
  return (
    <span
      title={t('badgeFull')}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 text-caption font-medium leading-none text-muted-foreground',
        className,
      )}
    >
      <Sparkles className="size-3 shrink-0" aria-hidden="true" />
      <span aria-hidden="true">{t('badge')}</span>
      <span className="sr-only">{t('badgeFull')}</span>
    </span>
  );
}
