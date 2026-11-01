import { getTranslations } from 'next-intl/server';
import { cn } from '@/lib/cn';
import { Card } from '../ui/card';

/**
 * A section that could not load, in the frame of the section itself (title kept) so the page does
 * not jump. The retry is a plain link to the current page: it reloads everything.
 */
export async function SectionError({
  testId,
  title,
  section,
  href,
  className,
}: {
  testId: string;
  title: string;
  /** The section's name inside the sentence ("as despesas por grupo"). */
  section: string;
  href: string;
  className?: string;
}) {
  const t = await getTranslations('insights');
  const titleId = `${testId}-title`;
  return (
    <Card
      as="section"
      data-testid={testId}
      aria-labelledby={titleId}
      className={cn('grid grid-cols-1 content-start gap-2', className)}
    >
      <h2 id={titleId} className="text-card-title">
        {title}
      </h2>
      <p className="text-base text-muted-foreground">{t('sectionError', { section })}</p>
      <a
        href={href}
        className="inline-flex min-h-11 w-fit items-center text-base font-medium text-primary-text underline-offset-4 hover:underline"
      >
        {t('retry')}
      </a>
    </Card>
  );
}
