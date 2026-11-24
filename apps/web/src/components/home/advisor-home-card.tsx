'use client';

import { MessageCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAdvisor } from '@/components/advisor/advisor-context';
import { Suggestions } from '@/components/advisor/suggestions';
import { useHouseholdFormat } from '@/components/household-format';
import { usePrivacy } from '@/components/privacy';
import { Card, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import type { SuggestionKey } from '@/server/advisor-data';

/**
 * The Home card: the advisor's last answer (two lines) and three questions to start from. A chip
 * opens the window with that question already sent. The answer can hold amounts, so privacy mode
 * blurs it.
 */
export function AdvisorHomeCard({
  title,
  last,
  suggestions,
}: {
  title: string;
  last: { text: string; createdAt: Date } | null;
  suggestions: SuggestionKey[];
}) {
  const t = useTranslations('advisor');
  const { locale, timeZone } = useHouseholdFormat();
  const { hidden } = usePrivacy();
  const advisor = useAdvisor();
  return (
    <Card as="section" aria-labelledby="home-advisor-title" className="flex flex-col">
      <CardHeader
        title={title}
        titleId="home-advisor-title"
        icon={MessageCircle}
        link={{ href: '/advisor', label: t('home.open') }}
      />
      {last ? (
        <div className="mb-3 min-w-0">
          <p className={cn('line-clamp-2 break-words text-sm', hidden && 'select-none blur-sm')}>
            {last.text}
          </p>
          <p className="mt-1 text-caption font-normal text-muted-foreground">
            <time dateTime={last.createdAt.toISOString()}>
              {new Intl.DateTimeFormat(locale, {
                dateStyle: 'medium',
                timeStyle: 'short',
                timeZone,
              }).format(last.createdAt)}
            </time>
          </p>
        </div>
      ) : (
        <p className="mb-3 text-sm text-muted-foreground">{t('home.empty')}</p>
      )}
      <Suggestions
        keys={suggestions}
        wrapOnPhone
        className="mt-auto"
        onPick={(_key, text, trigger) =>
          advisor.openAdvisor({ question: text, returnFocus: trigger })
        }
      />
    </Card>
  );
}
