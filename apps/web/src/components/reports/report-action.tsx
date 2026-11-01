'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useState, useTransition } from 'react';
import { requestReportAction } from '@/server/actions/reports';
import { cn } from '@/lib/cn';
import { Alert } from '../ui/alert';
import { ConfirmDialog } from '../ui/alert-dialog';
import { Button } from '../ui/button';
import { focusPendingHeading } from './focus-pending';
import { useOnline } from './use-online';

/**
 * `generate`: no report yet (first one, not counted). `regenerate`: replace a ready report, after
 * a confirmation. `again`: a month with too little data, nothing is replaced. `retry`: a failed
 * report.
 */
export type ReportActionMode = 'generate' | 'regenerate' | 'again' | 'retry';

type Problem = 'aiOff' | 'noKey' | 'limit' | 'monthNotClosed' | 'generic';

/**
 * Asks for the report of the last closed month. The server action only queues it (the worker
 * writes it), so the page shows the pending state straight after. The number of regenerations left
 * is always written next to the button, before it is spent. Errors show inline, not only as a toast.
 */
export function ReportAction({
  month,
  monthLabel,
  mode,
  left,
  max,
  aiAvailable,
  isOwner,
  className,
}: {
  month: string;
  monthLabel: string;
  mode: ReportActionMode;
  /** Regenerations left for this month. */
  left: number;
  /** The most times a month's report can be generated again. */
  max: number;
  aiAvailable: boolean;
  isOwner: boolean;
  className?: string;
}) {
  const t = useTranslations('reports');
  const online = useOnline();
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<Problem | null>(null);
  const helpId = useId();

  function submit() {
    setProblem(null);
    start(async () => {
      const result = await requestReportAction(month);
      if (result.ok) {
        if (result.data === 'unavailable') setProblem(aiAvailable ? 'aiOff' : 'noKey');
        else if (result.data === 'not_latest') setProblem('monthNotClosed');
        else focusPendingHeading.next = true;
        return;
      }
      const code = result.code === 'validation' ? result.detail?.code : undefined;
      setProblem(
        code === 'regenerate_limit'
          ? 'limit'
          : code === 'month_not_closed'
            ? 'monthNotClosed'
            : 'generic',
      );
    });
  }

  const help =
    mode === 'regenerate'
      ? t('regen.left', { count: left })
      : mode === 'retry'
        ? `${t('regen.retryHelp', { max })} ${t('regen.left', { count: left })}`
        : mode === 'again'
          ? `${t('regen.skippedHelp', { month: monthLabel })} ${t('regen.left', { count: left })}`
          : null;
  const label =
    mode === 'generate'
      ? t('generate.action', { month: monthLabel })
      : mode === 'retry'
        ? t('regen.retry')
        : t('regen.action');
  const variant = mode === 'generate' ? 'default' : 'secondary';
  const buttonClass = 'w-full md:w-auto';
  const described = help ? helpId : undefined;
  const busyLabel = t('generate.busy');

  const button = (
    <Button
      variant={variant}
      className={buttonClass}
      loading={pending}
      disabled={!online}
      aria-describedby={described}
      onClick={mode === 'regenerate' ? undefined : submit}
    >
      {pending ? busyLabel : label}
    </Button>
  );

  return (
    <div
      className={cn(
        'grid grid-cols-1 justify-items-start gap-2 max-md:justify-items-stretch',
        className,
      )}
    >
      {mode === 'regenerate' ? (
        <ConfirmDialog
          trigger={button}
          title={t('regen.dialogTitle', { month: monthLabel })}
          description={t('regen.dialogBody', { count: Math.max(0, left - 1) })}
          confirmLabel={t('regen.action')}
          cancelLabel={t('regen.dialogCancel')}
          confirmVariant="default"
          pending={pending}
          onConfirm={submit}
        />
      ) : (
        button
      )}
      {help ? (
        <p id={helpId} className="text-sm text-muted-foreground">
          {help}
        </p>
      ) : null}
      {problem ? (
        <Alert tone="error" className="w-full">
          {problem === 'limit'
            ? t('limit.reached', { month: monthLabel, max })
            : problem === 'monthNotClosed'
              ? t('error.monthNotClosed')
              : problem === 'noKey'
                ? t('error.noKey')
                : problem === 'aiOff'
                  ? t('error.aiOff')
                  : t('error.generic')}
          {problem === 'aiOff' && isOwner ? (
            <>
              {' '}
              <Link
                href="/settings/household#ai"
                className="font-medium text-primary underline underline-offset-4"
              >
                {t('error.settingsLink')}
              </Link>
            </>
          ) : null}
        </Alert>
      ) : null}
    </div>
  );
}
