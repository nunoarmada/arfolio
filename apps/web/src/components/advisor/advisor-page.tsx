'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import { Card } from '@/components/ui/card';
import type { AdvisorState } from '@/server/advisor-data';
import { useAdvisor } from './advisor-context';
import { AdvisorChat, markSeen } from './advisor-chat';
import { AdvisorMenu } from './advisor-menu';
import type { PanelName } from './advisor-panels';
import { useAdvisorChat } from './use-advisor-chat';

/** The /advisor page: the same conversation as the window, full height in one card. */
export function AdvisorPage({ initial }: { initial: AdvisorState }) {
  const t = useTranslations('advisor');
  const { brandName } = useAdvisor();
  const controller = useAdvisorChat({ initial, enabled: true });
  const [panel, setPanel] = useState<PanelName>('chat');
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Opening the page counts as reading the member's check-ins.
  useEffect(() => {
    markSeen();
  }, []);

  return (
    <PageContainer width="narrow">
      <PageHeader
        title={t('title', { brand: brandName })}
        actions={
          controller.status === 'ready' ? (
            <AdvisorMenu onPanel={setPanel} onCleared={controller.cleared} />
          ) : undefined
        }
      />
      <Card
        as="section"
        aria-label={t('conversation')}
        pad="none"
        className="flex h-[calc(100dvh-14rem-env(safe-area-inset-bottom))] min-h-[420px] flex-col overflow-hidden md:h-[calc(100dvh-8.5rem)]"
      >
        <AdvisorChat
          controller={controller}
          variant="page"
          panel={panel}
          onPanelChange={setPanel}
          composerRef={composerRef}
        />
      </Card>
    </PageContainer>
  );
}
