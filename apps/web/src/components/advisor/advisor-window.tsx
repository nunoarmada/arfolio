'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import { Sheet } from '@/components/ui/sheet';
import { cn } from '@/lib/cn';
import { useAdvisor, useIsDesktop } from './advisor-context';
import { AdvisorChat, markSeen } from './advisor-chat';
import { ADVISOR_WINDOW_ID } from './advisor-launcher';
import type { PanelName } from './advisor-panels';
import { useAdvisorChat } from './use-advisor-chat';

const CLOSE_MS = 120;

/** Keeps the window rendered for the length of its closing animation. */
function useRendered(visible: boolean): boolean {
  const [rendered, setRendered] = useState(visible);
  useEffect(() => {
    if (visible) {
      setRendered(true);
      return;
    }
    const timer = window.setTimeout(() => setRendered(false), CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [visible]);
  return visible || rendered;
}

/**
 * The advisor in the shell: a floating window from md up, a sheet below. It mounts the first time
 * the member opens it and then stays mounted (hidden) so the conversation, and an answer still
 * being written, survive minimising and navigating. It owns the conversation controller.
 */
export function AdvisorWindow() {
  const t = useTranslations('advisor');
  const advisor = useAdvisor();
  const desktop = useIsDesktop();
  const titleId = useId();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const focused = useRef(false);
  const [panel, setPanel] = useState<PanelName>('chat');
  const visible = advisor.open && !advisor.onAdvisorPage;
  const rendered = useRendered(visible);
  const controller = useAdvisorChat({ enabled: advisor.available && advisor.everOpened });
  const { status, streaming, send, refresh } = controller;

  // Opening counts as reading the check-ins, and shows any that arrived since the last load.
  useEffect(() => {
    if (!visible) return;
    markSeen();
  }, [visible]);
  useEffect(() => {
    if (visible && advisor.unreadProactive && status === 'ready') void refresh();
    // Only when the window opens: the unread flag flips right after markSeen.
  }, [visible]);

  // Focus goes to the composer once it exists; on a phone that would raise the keyboard, so there
  // the sheet keeps focus on itself.
  useEffect(() => {
    if (!visible) {
      focused.current = false;
      return;
    }
    if (status === 'ready' && !focused.current) {
      focused.current = true;
      if (!window.matchMedia('(pointer: coarse)').matches) composerRef.current?.focus();
    }
  }, [visible, status]);

  // A question from the Home card is sent once the conversation is ready.
  const { pendingQuestion, consumeQuestion } = advisor;
  useEffect(() => {
    if (!pendingQuestion || status === 'loading') return;
    const question = consumeQuestion();
    if (question && status === 'ready' && !streaming) send(question);
  }, [pendingQuestion, status, streaming, send, consumeQuestion]);

  // The desktop window is not modal, so closing it hands focus back by itself.
  const wasVisible = useRef(false);
  useEffect(() => {
    if (wasVisible.current && !visible && desktop) advisor.restoreFocus();
    wasVisible.current = visible;
  }, [visible, desktop]);

  if (!advisor.available || !advisor.everOpened) return null;

  const chat = (variant: 'window' | 'sheet') => (
    <AdvisorChat
      controller={controller}
      variant={variant}
      panel={panel}
      onPanelChange={setPanel}
      composerRef={composerRef}
      titleId={variant === 'window' ? titleId : undefined}
      onMinimise={() => advisor.closeAdvisor()}
      {...(variant === 'window'
        ? { onOpenFullPage: () => advisor.closeAdvisor({ restoreFocus: false }) }
        : {})}
    />
  );

  if (!desktop) {
    return (
      <Sheet
        open={visible}
        onOpenChange={(open) => {
          if (!open) advisor.closeAdvisor();
        }}
        title={t('title', { brand: advisor.brandName })}
        titleHidden
        full
        onOpenAutoFocus={(event) => {
          // Focus the composer when there is one and a keyboard is no surprise.
          if (composerRef.current && !window.matchMedia('(pointer: coarse)').matches) {
            event.preventDefault();
            composerRef.current.focus();
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          advisor.restoreFocus();
        }}
      >
        <div className="h-full bg-surface-raised">{chat('sheet')}</div>
      </Sheet>
    );
  }

  return (
    <div
      id={ADVISOR_WINDOW_ID}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      hidden={!rendered}
      inert={!visible}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) advisor.closeAdvisor();
      }}
      className={cn(
        'fixed bottom-6 right-6 z-40 flex h-[min(640px,calc(100dvh-3rem))] w-[400px] origin-bottom-right flex-col overflow-hidden rounded-xl bg-surface-raised shadow-overlay',
        visible
          ? 'animate-in fade-in-0 zoom-in-95 duration-[180ms]'
          : 'animate-out fade-out-0 zoom-out-95 duration-[120ms] fill-mode-forwards',
      )}
    >
      {chat('window')}
    </div>
  );
}
