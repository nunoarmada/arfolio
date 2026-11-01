'use client';

import { Clock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { POLL_INTERVAL_MS, POLL_MAX_TICKS } from '@/lib/reports';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/skeleton';
import { focusPendingHeading } from './focus-pending';

/**
 * Refreshes the page every 10 s while a report is pending: at most 12 times (two minutes), paused
 * while the tab is hidden and started afresh when it is visible again. It only ever re-reads the
 * page; nothing here changes data.
 */
export function usePendingPoll(): { stopped: boolean; checkNow: () => void } {
  const router = useRouter();
  const [stopped, setStopped] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    // The count survives the tab being hidden and shown: only a manual check starts a new window.
    let ticks = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const clear = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      clear();
      if (ticks >= POLL_MAX_TICKS) return;
      timer = setInterval(() => {
        ticks += 1;
        router.refresh();
        if (ticks >= POLL_MAX_TICKS) {
          clear();
          setStopped(true);
        }
      }, POLL_INTERVAL_MS);
    };
    const onVisibility = () => {
      if (document.hidden) clear();
      else start();
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clear();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [router, round]);

  return {
    stopped,
    checkNow: () => {
      router.refresh();
      setStopped(false);
      setRound((r) => r + 1);
    },
  };
}

/** Keeps the list fresh while any visible row is pending. Renders nothing. */
export function ReportAutoRefresh() {
  usePendingPoll();
  return null;
}

/**
 * The state region of a pending report, in the frame of the finished one so the page does not
 * jump. Three still lines while it polls; after two minutes it says so and offers a manual check.
 */
export function PendingPanel({ month }: { month: string }) {
  const t = useTranslations('reports.detail');
  const { stopped, checkNow } = usePendingPoll();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusPendingHeading.next) {
      focusPendingHeading.next = false;
      heading.current?.focus();
    }
  }, []);
  return (
    <section
      aria-labelledby="report-pending-title"
      data-testid="report-pending"
      className="grid grid-cols-1 gap-4 rounded-lg bg-surface shadow-card p-4 md:p-6"
    >
      <div className="flex items-center gap-2">
        <Clock className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h2
          id="report-pending-title"
          ref={heading}
          tabIndex={-1}
          className="min-w-0 wrap-anywhere text-base font-semibold outline-none"
        >
          {t('pendingTitle', { month })}
        </h2>
      </div>
      {stopped ? (
        <div className="grid grid-cols-1 justify-items-start gap-3">
          <p className="max-w-[68ch] text-base text-muted-foreground">{t('pendingStopped')}</p>
          <Button variant="secondary" onClick={checkNow}>
            {t('checkNow')}
          </Button>
        </div>
      ) : (
        <>
          <p className="max-w-[68ch] text-base text-muted-foreground">{t('pendingBody')}</p>
          <div className="grid grid-cols-1 gap-3" aria-hidden="true">
            <Skeleton className="h-7 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        </>
      )}
    </section>
  );
}
