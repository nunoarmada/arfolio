'use client';

import { Link2, Unplug } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { zonedDate } from '@/lib/when';
import { revokeAppAction } from '@/server/actions/integrations';
import type { AppDto } from '@/server/integrations-data';
import { useHouseholdFormat } from '../household-format';
import { Button } from '../ui/button';
import { useToast } from '../ui/toast';
import { RevokeDialog } from './revoke-dialog';
import { CollapsibleRow, EmptyCard, LoadError, SectionHeader } from './shared';
import { useRowRemoval } from './use-row-removal';

const TITLE_ID = 'apps-title';

/** Connected apps: this user's OAuth consents, with revoke (consent and tokens, audited). */
export function AppsSection({
  apps,
  onShowGuide,
}: {
  /** Null when the list could not be loaded. */
  apps: AppDto[] | null;
  onShowGuide: () => void;
}) {
  const t = useTranslations('integrations.apps');
  const toast = useToast();
  const { locale, timeZone } = useHouseholdFormat();
  const [asking, setAsking] = useState<AppDto | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const removal = useRowRemoval(
    (apps ?? []).map((app) => app.clientId),
    TITLE_ID,
    asking !== null,
  );
  const nameOf = (app: AppDto) => app.name ?? app.host ?? app.clientId;

  async function revoke(app: AppDto) {
    setPending(true);
    setFailed(false);
    const result = await revokeAppAction(app.clientId).catch(() => null);
    setPending(false);
    if (result?.ok) {
      setAsking(null);
      toast.success(t('revoked'));
      removal.collapse(app.clientId);
    } else {
      setFailed(true);
    }
  }

  return (
    <>
      {apps === null ? (
        <LoadError id={TITLE_ID} title={t('title')} help={t('help')} message={t('loadError')} />
      ) : apps.length === 0 ? (
        <section aria-labelledby={TITLE_ID} className="grid grid-cols-1 gap-3">
          <SectionHeader id={TITLE_ID} title={t('title')} help={t('help')} />
          <EmptyCard
            icon={<Unplug className="size-6" />}
            action={
              <Button variant="link" className="-ml-1" onClick={onShowGuide}>
                {t('emptyLink')}
              </Button>
            }
          >
            {t('empty')}
          </EmptyCard>
        </section>
      ) : (
        <section aria-labelledby={TITLE_ID} className="grid grid-cols-1 gap-3">
          <SectionHeader id={TITLE_ID} title={t('title')} help={t('help')} />
          <ul
            data-testid="app-list"
            className="divide-y divide-border overflow-hidden rounded-lg bg-surface shadow-card"
          >
            {apps.map((app) => (
              <CollapsibleRow key={app.clientId} collapsed={removal.collapsing.has(app.clientId)}>
                <div className="flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap">
                  <Link2 className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0 flex-1 basis-40">
                    <p className="break-words text-base font-medium">{nameOf(app)}</p>
                    <p className="text-sm text-muted-foreground">
                      {app.write ? t('perm.readWrite') : t('perm.read')}
                      {' · '}
                      {t('granted', { date: zonedDate(app.grantedAt, locale, timeZone) })}
                    </p>
                  </div>
                  <Button
                    ref={removal.buttonRef(app.clientId)}
                    variant="outline"
                    className="h-11 shrink-0 max-sm:w-full md:h-9 md:px-3 md:text-sm"
                    aria-label={t('revokeNamed', { name: nameOf(app) })}
                    onClick={(event) => {
                      removal.opener.current = event.currentTarget;
                      setFailed(false);
                      setAsking(app);
                    }}
                  >
                    {t('revoke')}
                  </Button>
                </div>
              </CollapsibleRow>
            ))}
          </ul>
        </section>
      )}

      <RevokeDialog
        open={asking !== null}
        title={t('revokeTitle', { name: asking ? nameOf(asking) : '' })}
        description={t('revokeBody', { name: asking ? nameOf(asking) : '' })}
        confirmLabel={t('revoke')}
        error={failed ? t('revokeError') : null}
        pending={pending}
        onCancel={() => setAsking(null)}
        onConfirm={() => asking && void revoke(asking)}
        onCloseAutoFocus={removal.onDialogClosed}
      />
    </>
  );
}
