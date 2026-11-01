'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { claudeCodeCommand } from '@/lib/mcp-command';
import type { IntegrationsData } from '@/server/integrations-data';
import { ActivitySection } from './activity-section';
import { AppsSection } from './apps-section';
import { ConnectionGuide } from './connection-guide';
import { TokensSection } from './tokens-section';

/**
 * The Integrações (MCP) page body: intro, the collapsible guide, tokens, connected apps and (for
 * owners) recent activity. Each list handles its own loading failure, so one never blanks the page.
 */
export function IntegrationsView({
  data,
  url,
  brandName,
  now,
  role,
}: {
  data: IntegrationsData;
  url: string;
  brandName: string;
  now: string;
  role: 'owner' | 'member' | 'viewer';
}) {
  const t = useTranslations('integrations');
  // Newcomers see the guide open; people who already connected something go straight to their lists.
  const [guideOpen, setGuideOpen] = useState(
    () => data.tokens?.length === 0 && data.apps?.length === 0,
  );

  function showGuide() {
    setGuideOpen(true);
    const guide = document.getElementById('integrations-guide');
    guide?.scrollIntoView({ block: 'start' });
    guide?.querySelector('summary')?.focus();
  }

  function toTokens() {
    const heading = document.getElementById('tokens-title');
    heading?.scrollIntoView({ block: 'start' });
    heading?.focus();
  }

  return (
    <div className="grid grid-cols-1 gap-6 md:gap-8">
      <p className="max-w-[68ch] text-base text-muted-foreground">{t('intro')}</p>
      <ConnectionGuide
        open={guideOpen}
        onOpenChange={setGuideOpen}
        url={url}
        command={claudeCodeCommand(brandName, url, '<token>')}
        brandName={brandName}
        onToTokens={toTokens}
      />
      <TokensSection
        tokens={data.tokens}
        now={now}
        viewer={role === 'viewer'}
        brandName={brandName}
        url={url}
      />
      <AppsSection apps={data.apps} onShowGuide={showGuide} />
      {data.activity !== undefined ? <ActivitySection activity={data.activity} now={now} /> : null}
    </div>
  );
}
