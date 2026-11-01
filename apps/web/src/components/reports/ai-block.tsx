import { CircleCheck, Info, Lightbulb, Sparkles, TriangleAlert } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import type { ReportContent } from '@arfolio/services';
import { cn } from '@/lib/cn';
import { Card } from '../ui/card';

const TONE = {
  positive: { Icon: CircleCheck, cls: 'text-positive' },
  neutral: { Icon: Info, cls: 'text-muted-foreground' },
  attention: { Icon: TriangleAlert, cls: 'text-warning' },
} as const;

const ROW = 'grid grid-cols-1 content-start gap-1 rounded-md bg-surface-2 p-3 md:p-4';

/**
 * What the model wrote, in one bordered block closed by the footnote: the only place on the page
 * where words come from a model. Every string is a React text node (no markdown, no HTML), and
 * long names or words wrap instead of widening the page. `controls` is the regenerate button.
 */
export async function AiBlock({
  content,
  model,
  datetime,
  reportLocale,
  controls,
}: {
  content: ReportContent;
  model: string | null;
  /** When the report was generated, already formatted for the household. */
  datetime: string;
  /** The language the report was written in. */
  reportLocale: string;
  controls?: ReactNode;
}) {
  const [t, tone, uiLocale] = await Promise.all([
    getTranslations('reports.detail'),
    getTranslations('reports.tone'),
    getLocale(),
  ]);
  return (
    <Card
      as="section"
      variant="hero"
      aria-labelledby="report-ai-title"
      data-testid="report-ai"
      lang={reportLocale !== uiLocale ? reportLocale : undefined}
      className="grid grid-cols-1 gap-6 md:p-6 xl:p-8"
    >
      <div className="grid grid-cols-1 gap-3">
        <h2
          id="report-ai-title"
          className="inline-flex h-6 w-fit items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-caption font-medium text-muted-foreground"
        >
          <Sparkles className="size-3.5 shrink-0 text-primary-text" aria-hidden="true" />
          {t('aiLabel')}
        </h2>
        <p
          data-testid="report-headline"
          className="max-w-[68ch] wrap-anywhere text-xl font-semibold leading-snug tracking-[-0.015em] md:text-2xl md:leading-8"
        >
          {content.headline}
        </p>
        <p className="max-w-[68ch] whitespace-pre-line wrap-anywhere text-base leading-[26px]">
          {content.overview}
        </p>
      </div>

      {content.findings.length > 0 ? (
        <div className="grid grid-cols-1 gap-2">
          <h3 className="text-card-title">{t('findings')}</h3>
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {content.findings.map((f, i) => {
              const { Icon, cls } = TONE[f.tone];
              return (
                <li key={i} className={ROW}>
                  <span
                    className={cn('inline-flex items-center gap-1 text-caption font-medium', cls)}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    {tone(f.tone)}
                  </span>
                  <p className="wrap-anywhere text-base font-semibold">{f.title}</p>
                  <p className="max-w-[68ch] wrap-anywhere text-sm text-muted-foreground">
                    {f.detail}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {content.suggestions.length > 0 ? (
        <div className="grid grid-cols-1 gap-2">
          <h3 className="text-card-title">{t('suggestions')}</h3>
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {content.suggestions.map((s, i) => (
              <li key={i} className={ROW}>
                <p className="flex items-start gap-2 wrap-anywhere text-base font-semibold">
                  <Lightbulb
                    className="mt-1 size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 wrap-anywhere">{s.title}</span>
                </p>
                <p className="max-w-[68ch] wrap-anywhere pl-6 text-sm text-muted-foreground">
                  {s.detail}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {controls ? <div className="md:flex md:justify-end">{controls}</div> : null}

      <p className="wrap-anywhere border-t border-border pt-3 text-caption font-normal text-muted-foreground">
        {t('footnote', { model: model ?? '—', datetime })}
      </p>
    </Card>
  );
}
