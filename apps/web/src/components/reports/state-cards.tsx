import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { ReportsContext } from '@/server/reports-data';
import { buttonVariants } from '../ui/button';
import { Card } from '../ui/card';
import { ReportAction } from './report-action';

/** A compact state card: a title, a short explanation and at most one action. */
export function StateCard({
  title,
  children,
  action,
  testId,
  as: Heading = 'h3',
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  testId?: string;
  /** The heading level that keeps the page's outline in order. */
  as?: 'h2' | 'h3';
}) {
  return (
    <Card as="section" data-testid={testId} className="grid grid-cols-1 justify-items-start gap-2">
      <Heading className="text-card-title">{title}</Heading>
      {children ? <p className="max-w-[68ch] text-sm text-muted-foreground">{children}</p> : null}
      {action}
    </Card>
  );
}

/** True when no new report can be generated here: no API key, or AI switched off. */
export const aiBlocked = (rc: ReportsContext): boolean => !rc.aiAvailable || !rc.aiEnabled;

/**
 * Why there will be no new reports: no key on this installation, or AI off for the household
 * (owners get the way to turn it on). Null when AI is available and on. The first match wins.
 */
export async function AiStateCard({ rc, as }: { rc: ReportsContext; as?: 'h2' | 'h3' }) {
  const t = await getTranslations('reports.empty');
  if (!rc.aiAvailable) {
    return (
      <StateCard
        testId="reports-no-key"
        as={as}
        title={t('noKey.title')}
        action={
          rc.role === 'owner' ? (
            <Link href="/settings/services#ai" className={buttonVariants({ variant: 'secondary' })}>
              {t('noKey.action')}
            </Link>
          ) : undefined
        }
      >
        {t('noKey.body')}
      </StateCard>
    );
  }
  if (rc.aiEnabled) return null;
  if (rc.role === 'owner') {
    return (
      <StateCard
        testId="reports-ai-off"
        as={as}
        title={t('aiOffOwner.title')}
        action={
          <Link href="/settings/household#ai" className={buttonVariants({ variant: 'secondary' })}>
            {t('aiOffOwner.action')}
          </Link>
        }
      >
        {t('aiOffOwner.body')}
      </StateCard>
    );
  }
  return (
    <StateCard testId="reports-ai-off" as={as} title={t('aiOffOther.title')}>
      {t('aiOffOther.body')}
    </StateCard>
  );
}

/** The month has no report yet: owners and members can ask for it, viewers are told it is coming. */
export async function GenerateCard({
  month,
  monthLabel,
  rc,
  as,
}: {
  month: string;
  monthLabel: string;
  rc: ReportsContext;
  as?: 'h2' | 'h3';
}) {
  const t = await getTranslations('reports');
  if (rc.role === 'viewer') {
    return (
      <StateCard testId="reports-first-soon" as={as} title={t('empty.firstSoon.title')}>
        {t('empty.firstSoon.body', { month: monthLabel })}
      </StateCard>
    );
  }
  return (
    <StateCard
      testId="reports-generate"
      as={as}
      title={t('generate.title', { month: monthLabel })}
      action={
        <ReportAction
          month={month}
          monthLabel={monthLabel}
          mode="generate"
          left={rc.maxRegenerations}
          max={rc.maxRegenerations}
          aiAvailable={rc.aiAvailable}
          isOwner={rc.role === 'owner'}
          className="w-full md:w-auto"
        />
      }
    >
      {t('generate.body')}
    </StateCard>
  );
}
