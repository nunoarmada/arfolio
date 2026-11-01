import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { getSessionContext } from '@/server/session';
import type { SettingsGroup } from './settings-frame';

/** The settings sections, grouped the way the index and the xl sub-nav show them. */
const GROUPS = [
  {
    id: 'household',
    keys: ['household', 'budget', 'categories', 'rules', 'branding', 'services'],
  },
  { id: 'people', keys: ['members'] },
  { id: 'data', keys: ['import'] },
  // Integrations stays right after Segurança: MCP tokens are the member's own access.
  { id: 'account', keys: ['security', 'integrations', 'preferences'] },
] as const;

/** Sections only the household owner sees (instance-wide settings and their credentials). */
const OWNER_ONLY: ReadonlySet<string> = new Set(['services']);

export async function getSettingsGroups(): Promise<SettingsGroup[]> {
  const [t, session] = await Promise.all([
    getTranslations('settings'),
    getSessionContext(await headers()),
  ]);
  const isOwner = session?.role === 'owner';
  return GROUPS.map((group) => ({
    id: group.id,
    label: t(`groups.${group.id}`),
    sections: group.keys
      .filter((key) => isOwner || !OWNER_ONLY.has(key))
      .map((key) => ({
        key,
        href: `/settings/${key}`,
        label: t(`${key}.label`),
        description: t(`${key}.description`),
      })),
  }));
}
