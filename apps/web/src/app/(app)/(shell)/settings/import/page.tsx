import { listImportPresets } from '@arfolio/services';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { PresetsView } from '@/components/settings/presets-view';
import { toServiceCtx } from '@/server/service-ctx';
import { requireMember } from '@/server/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations('presets'))('title') };
}

export default async function ImportPresetsPage() {
  const [session, t, settings] = await Promise.all([
    requireMember(await headers()),
    getTranslations('presets'),
    getTranslations('settings'),
  ]);
  const presets = await listImportPresets(toServiceCtx(session));
  return (
    <>
      <PageHeader title={t('title')} backHref="/settings" backLabel={settings('back')} />
      <PresetsView
        presets={presets.map((p) => ({
          id: p.id,
          name: p.name,
          kind: p.kind,
          columns: [
            p.mapping.dateColumn,
            p.mapping.descriptionColumn,
            p.mapping.amountColumn ?? p.mapping.debitColumn ?? '',
          ].filter(Boolean),
        }))}
        canWrite={session.role !== 'viewer'}
      />
    </>
  );
}
