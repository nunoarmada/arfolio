'use client';

import { useTranslations } from 'next-intl';
import { confidenceBand } from '@/lib/ai-confidence';

/**
 * The band word for an AI suggestion ("Sugestão provável"), with the caveat in a tooltip and for
 * screen readers. Renders nothing when the AI applied the category or gave no confidence.
 */
export function ConfidenceLabel({
  confidence,
  short = false,
}: {
  confidence: number | null;
  /** The one-word form used inside a chip ("provável"). */
  short?: boolean;
}) {
  const t = useTranslations('ai');
  const band = confidenceBand(confidence);
  if (!band) return null;
  return (
    <span title={t('bandHint')}>
      <span>{short ? t(`${band}Short`) : t(band)}</span>
      <span className="sr-only">. {t('bandHint')}</span>
    </span>
  );
}
