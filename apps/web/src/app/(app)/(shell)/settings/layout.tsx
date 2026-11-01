import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { getSettingsGroups } from './sections';
import { SettingsFrame } from './settings-frame';

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const [groups, t] = await Promise.all([getSettingsGroups(), getTranslations('settings')]);
  return (
    <SettingsFrame groups={groups} label={t('sections')} backLabel={t('back')}>
      {children}
    </SettingsFrame>
  );
}
