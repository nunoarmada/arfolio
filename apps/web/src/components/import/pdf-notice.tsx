import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Alert } from '../ui/alert';
import { buttonVariants } from '../ui/button';

export type ImportAiState = {
  /** The installation has an AI API key. */
  available: boolean;
  /** The household switched AI on. */
  enabled: boolean;
  /** The member may switch AI on (owners only). */
  canEnable: boolean;
};

/** True when a PDF can be sent: the installation has a key and the household opted in. */
export function canReadPdf(ai: ImportAiState): boolean {
  return ai.available && ai.enabled;
}

/**
 * Shown under the drop area once a PDF is chosen. Either says plainly where the file goes, or why
 * it cannot be read and who can fix that.
 */
export function PdfNotice({ ai }: { ai: ImportAiState }) {
  const t = useTranslations('import.upload.pdf');
  if (canReadPdf(ai)) {
    return (
      <div data-testid="pdf-notice">
        <Alert tone="info" title={t('title')}>
          {t('body')}
        </Alert>
      </div>
    );
  }
  return (
    <div data-testid="pdf-notice">
      <div data-testid="pdf-unavailable">
        <Alert
          tone="info"
          action={
            ai.canEnable ? (
              <Link
                href={ai.available ? '/settings/household' : '/settings/services'}
                className={buttonVariants({ variant: 'outline' })}
              >
                {ai.available ? t('switchOn') : t('setUp')}
              </Link>
            ) : null
          }
        >
          <p>{t('unavailable')}</p>
          {ai.canEnable ? null : <p>{t('askOwner')}</p>}
        </Alert>
      </div>
    </div>
  );
}
