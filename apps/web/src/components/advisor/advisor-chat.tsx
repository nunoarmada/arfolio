'use client';

import { AlertCircle, Hourglass, Maximize2, Minus, Sparkles, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { EmptyState } from '@/components/empty-state';
import { buttonVariants } from '@/components/ui/button';
import { Button } from '@/components/ui/button';
import { usePrivacy } from '@/components/privacy';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';
import { markAdvisorSeenAction } from '@/server/actions/advisor';
import { useAdvisor } from './advisor-context';
import { AdvisorMenu } from './advisor-menu';
import { NotesPanel, SettingsPanel, type PanelName } from './advisor-panels';
import { Composer } from './composer';
import { MessageList } from './message-list';
import { Suggestions } from './suggestions';
import type { AdvisorChatController } from './use-advisor-chat';

export type ChatVariant = 'window' | 'sheet' | 'page';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Marks the member's check-ins read; a failure only leaves the unread dot a little longer. */
export function markSeen(): void {
  void markAdvisorSeenAction();
}

function LoadingBubbles() {
  const t = useTranslations('advisor');
  return (
    <div role="status" aria-busy="true" className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <span className="sr-only">{t('loading')}</span>
      <Skeleton className="h-16 w-3/4 rounded-xl" />
      <Skeleton className="ml-auto h-10 w-1/2 rounded-xl" />
      <Skeleton className="h-20 w-4/5 rounded-xl" />
    </div>
  );
}

function ChatEmpty({ children }: { children: ReactNode }) {
  const t = useTranslations('advisor.empty');
  return (
    <div className="flex flex-col items-start gap-3 p-5">
      <span
        aria-hidden="true"
        className="flex size-10 items-center justify-center rounded-lg bg-primary-soft text-primary-text"
      >
        <Sparkles className="size-5" />
      </span>
      <h3 className="text-base font-semibold">{t('title')}</h3>
      <p className="max-w-[40ch] text-sm text-muted-foreground">{t('body')}</p>
      {children}
    </div>
  );
}

function LearningBanner({
  completeMonths,
  required,
}: {
  completeMonths: number;
  required: number;
}) {
  const t = useTranslations('advisor.learning');
  const fill = required > 0 ? completeMonths / required : 0;
  return (
    <Card variant="inset" pad="sm" className="grid grid-cols-1 gap-2 md:p-3">
      <div className="flex items-start gap-2.5">
        <Hourglass className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline justify-between gap-2 text-sm font-medium">
            <span>{t('title')}</span>
            <span className="text-label font-normal tabular-nums text-muted-foreground md:hidden">
              {completeMonths}/{required}
            </span>
          </p>
          <p className="hidden text-label font-normal text-muted-foreground md:block">
            {t('body', { completeMonths, required })}
          </p>
        </div>
      </div>
      <Progress
        compact
        fill={fill}
        label={t('meter')}
        valueNow={Math.round(fill * 100)}
        valueText={t('body', { completeMonths, required })}
      />
    </Card>
  );
}

/** The AI is off, or the advisor has no model yet: what to do, and for owners where to do it. */
function Unavailable({
  kind,
  reason,
  isOwner,
}: {
  kind: 'off' | 'not_configured';
  reason: 'no_key' | 'household_off' | null;
  isOwner: boolean;
}) {
  const t = useTranslations(kind === 'off' ? 'advisor.off' : 'advisor.notConfigured');
  const href =
    kind === 'not_configured' || reason === 'no_key'
      ? '/settings/services'
      : '/settings/household#ai';
  return (
    <div className="p-4">
      <EmptyState icon={<AlertCircle />} title={t('title')} className="shadow-none">
        {isOwner ? t('owner') : t('member')}
        {isOwner ? (
          <Link
            href={href}
            className={cn(buttonVariants({ variant: 'outline' }), 'mt-3 flex w-fit')}
          >
            {t('action')}
          </Link>
        ) : null}
      </EmptyState>
    </div>
  );
}

/**
 * The advisor conversation, shared by the floating window, the phone sheet and the /advisor page.
 * It owns the layout (header, the conversation or a panel, the composer) and nothing about where
 * it is shown; the controller owns the data.
 */
export function AdvisorChat({
  controller,
  variant,
  panel,
  onPanelChange,
  composerRef,
  titleId,
  onMinimise,
  onOpenFullPage,
}: {
  controller: AdvisorChatController;
  variant: ChatVariant;
  panel: PanelName;
  onPanelChange: (panel: PanelName) => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  titleId?: string;
  onMinimise?: () => void;
  onOpenFullPage?: () => void;
}) {
  const t = useTranslations('advisor');
  const { brandName, isOwner } = useAdvisor();
  const { hidden: privacyOn } = usePrivacy();
  const { status, state, messages } = controller;
  const ready = status === 'ready' && state !== null;
  const canApply = state?.canApply ?? false;
  const last = messages.at(-1);
  const empty = messages.length === 0 && !controller.turn && !controller.error;
  const staleConversation = last !== undefined && Date.now() - last.createdAt.getTime() > DAY_MS;
  const showChips = ready && state.suggestions.length > 0 && (empty || staleConversation);

  const pick = (text: string) => {
    controller.send(text);
    // The chip that was clicked leaves the page with the question; without this, keyboard focus
    // falls to the document and Escape no longer reaches the window. Not on touch screens, where
    // focusing the box would raise the keyboard over the answer.
    if (!window.matchMedia('(pointer: coarse)').matches) composerRef.current?.focus();
  };

  // Escape steps back from a panel first; a menu or dialog has already taken the key (the event
  // is then marked as handled), and only an untouched Escape reaches the window.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !event.defaultPrevented && panel !== 'chat') {
      event.preventDefault();
      onPanelChange('chat');
    }
  };

  return (
    <div onKeyDown={onKeyDown} className="relative flex h-full min-h-0 flex-col bg-inherit">
      {variant !== 'page' ? (
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b pl-3 pr-1.5">
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-text"
          >
            <Sparkles className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[15px] font-semibold leading-5">
              {t('title', { brand: brandName })}
            </h2>
            <p aria-live="polite" className="text-caption font-normal text-muted-foreground">
              {controller.streaming ? t('thinking') : t('status')}
            </p>
          </div>
          {ready ? <AdvisorMenu onPanel={onPanelChange} onCleared={controller.cleared} /> : null}
          {onOpenFullPage ? (
            <Link
              href="/advisor"
              aria-label={t('openFullPage')}
              onClick={onOpenFullPage}
              className="flex size-11 shrink-0 items-center justify-center rounded-md text-foreground hover:bg-surface-2"
            >
              <Maximize2 className="size-5" aria-hidden="true" />
            </Link>
          ) : null}
          {onMinimise ? (
            <Button variant="ghost" size="icon" aria-label={t('minimise')} onClick={onMinimise}>
              {variant === 'sheet' ? (
                <X className="size-5" aria-hidden="true" />
              ) : (
                <Minus className="size-5" aria-hidden="true" />
              )}
            </Button>
          ) : null}
        </div>
      ) : (
        <p aria-live="polite" className="sr-only">
          {controller.streaming ? t('thinking') : t('status')}
        </p>
      )}

      {status === 'loading' ? <LoadingBubbles /> : null}
      {status === 'error' ? (
        <div className="p-4">
          <EmptyState icon={<AlertCircle />} title={t('loadError')} className="shadow-none">
            <Button variant="outline" className="mt-3" onClick={() => void controller.refresh()}>
              {t('error.retry')}
            </Button>
          </EmptyState>
        </div>
      ) : null}
      {status === 'off' || status === 'not_configured' ? (
        <Unavailable kind={status} reason={controller.offReason} isOwner={isOwner} />
      ) : null}

      {ready && panel === 'settings' ? (
        <SettingsPanel onBack={() => onPanelChange('chat')} />
      ) : null}
      {ready && panel === 'notes' ? <NotesPanel onBack={() => onPanelChange('chat')} /> : null}

      {ready && panel === 'chat' ? (
        <>
          <MessageList
            messages={messages}
            turn={controller.turn}
            error={controller.error}
            hasMore={controller.hasMore}
            loadingOlder={controller.loadingOlder}
            olderFailed={controller.olderFailed}
            canApply={canApply}
            banner={
              state.learning.ready ? null : (
                <LearningBanner
                  completeMonths={state.learning.completeMonths}
                  required={state.learning.required}
                />
              )
            }
            empty={
              <ChatEmpty>
                {showChips ? (
                  <Suggestions
                    keys={state.suggestions}
                    disabled={controller.streaming}
                    onPick={(_key, text) => pick(text)}
                  />
                ) : null}
              </ChatEmpty>
            }
            onLoadOlder={controller.loadOlder}
            onRetry={(text) => controller.send(text, { retry: true })}
            onProposalStatus={controller.setProposalStatus}
            onRefresh={() => void controller.refresh()}
          />
          {showChips && !empty ? (
            <div className="border-t px-3 pt-3">
              <Suggestions
                keys={state.suggestions}
                disabled={controller.streaming}
                onPick={(_key, text) => pick(text)}
              />
            </div>
          ) : null}
          <Composer
            inputRef={composerRef}
            restore={controller.error?.restore ?? null}
            disabled={controller.streaming}
            onSend={(text) => controller.send(text)}
          />
        </>
      ) : null}

      <p aria-live="polite" className="sr-only">
        {(privacyOn && controller.announcement?.text
          ? t('answerReady')
          : controller.announcement?.text) ??
          (controller.announcement?.error
            ? t(
                controller.announcement.error === 'busy'
                  ? 'error.busy'
                  : controller.announcement.error === 'daily_limit'
                    ? 'error.dailyLimit'
                    : 'error.unavailable',
              )
            : '')}
      </p>
    </div>
  );
}
