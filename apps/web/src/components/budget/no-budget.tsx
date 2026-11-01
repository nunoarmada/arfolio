import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { buttonVariants } from '../ui/button';
import { EmptyState } from '../empty-state';

/** The three ways a budget page can have nothing to show, each with what to do next. */
export async function NoBudget({
  variant,
  canWrite,
  monthLabel,
  createHref,
  rangeLabel,
  nearest,
}: {
  variant: 'none' | 'uncovered' | 'noLines';
  canWrite: boolean;
  monthLabel?: string;
  /** Where "Criar orçamento" goes (uncovered). */
  createHref?: string;
  rangeLabel?: string;
  /** The nearest month a budget covers: { href, label }. */
  nearest?: { href: string; label: string } | null;
  addLineHref?: string;
}) {
  const t = await getTranslations('budget.empty');
  if (variant === 'none') {
    return (
      <EmptyState
        title={t('noneTitle')}
        action={
          canWrite ? (
            <div className="flex flex-wrap gap-3">
              <Link href="/budget/new" className={buttonVariants({})}>
                {t('create')}
              </Link>
              <Link href="/import/budget" className={buttonVariants({ variant: 'outline' })}>
                {t('import')}
              </Link>
            </div>
          ) : undefined
        }
      >
        {canWrite ? t('noneBody') : `${t('noneBody')} ${t('noneViewer')}`}
      </EmptyState>
    );
  }
  if (variant === 'uncovered') {
    return (
      <EmptyState
        title={t('uncoveredTitle', { month: monthLabel ?? '' })}
        action={
          <div className="flex flex-wrap items-center gap-3">
            {canWrite && createHref ? (
              <Link href={createHref} className={buttonVariants({})}>
                {t('createRange', { range: rangeLabel ?? '' })}
              </Link>
            ) : null}
            {nearest ? (
              <Link
                href={nearest.href}
                className="inline-flex min-h-11 items-center rounded-md px-2 text-base text-primary hover:underline"
              >
                {t('goTo', { month: nearest.label })}
              </Link>
            ) : null}
          </div>
        }
      >
        {t('uncoveredBody')}
      </EmptyState>
    );
  }
  return (
    <EmptyState
      title={t('noLinesTitle')}
      action={
        canWrite ? (
          <div className="flex flex-wrap gap-3">
            <Link href="/budget/lines/new" className={buttonVariants({})}>
              {t('addLine')}
            </Link>
            <Link href="/import/budget" className={buttonVariants({ variant: 'outline' })}>
              {t('import')}
            </Link>
          </div>
        ) : undefined
      }
    >
      {t('noLinesBody')}
    </EmptyState>
  );
}
