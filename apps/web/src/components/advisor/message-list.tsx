'use client';

import { AlertCircle, Bell, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { usePrivacy } from '@/components/privacy';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import type { ChatMessage, ChatProposal, ProposalStatus } from './advisor-types';
import { ProposalCard } from './proposal-card';
import type { ChatError, ChatTurn } from './use-advisor-chat';

const ARRIVE = 'animate-in fade-in-0 slide-in-from-bottom-1 duration-[180ms]';
const BUBBLE = 'break-words whitespace-pre-line px-3.5 py-2.5 text-[15px] leading-[22px]';
/** The tools the advisor can call, mapped to the sentence that says what it is looking at. */
const TOOL_LABELS: Record<string, string> = {
  get_budget_vs_actual: 'budget',
  get_net_worth: 'netWorth',
  get_overview: 'accounts',
  list_accounts: 'accounts',
  list_categories: 'transactions',
  search_transactions: 'transactions',
  list_review_inbox: 'transactions',
  get_spending_profile: 'spending',
  list_goals: 'goals',
  propose_action: 'propose',
  save_note: 'note',
};

/** The advisor's words. With privacy mode on they are blurred (they can hold amounts) until selected. */
function AssistantText({ text, proactive = false }: { text: string; proactive?: boolean }) {
  const t = useTranslations('advisor');
  const { hidden } = usePrivacy();
  const [revealed, setRevealed] = useState(false);
  const masked = hidden && !revealed;
  return (
    <div
      className={cn(
        BUBBLE,
        'rounded-xl rounded-bl-sm bg-surface-2 text-foreground',
        proactive && 'shadow-[inset_2px_0_0_var(--primary-border)]',
        masked && 'cursor-pointer select-none blur-sm',
      )}
      {...(masked
        ? {
            tabIndex: 0,
            title: t('privacyReveal'),
            onClick: () => setRevealed(true),
            onFocus: () => setRevealed(true),
          }
        : {})}
    >
      <span className="sr-only">{t('speakerAdvisor')}: </span>
      {text}
    </div>
  );
}

function TypingBubble() {
  return (
    <div
      aria-hidden="true"
      className="inline-flex items-center gap-1 rounded-xl rounded-bl-sm bg-surface-2 px-3.5 py-4"
    >
      {[0, 160, 320].map((delay) => (
        <span
          key={delay}
          className="size-1.5 animate-pulse rounded-full bg-muted-foreground [animation-duration:1.2s] motion-reduce:animate-none motion-reduce:opacity-60"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  );
}

function ErrorBubble({
  error,
  onRetry,
}: {
  error: ChatError['code'];
  onRetry: (() => void) | null;
}) {
  const t = useTranslations('advisor.error');
  return (
    <Card
      tone="negative"
      pad="none"
      className="grid max-w-[90%] grid-cols-1 gap-2 rounded-xl rounded-bl-sm p-3"
    >
      <p className="flex items-start gap-2 text-[15px] leading-[22px]">
        <AlertCircle className="mt-0.5 size-5 shrink-0 text-negative" aria-hidden="true" />
        <span>
          {error === 'busy'
            ? t('busy')
            : error === 'daily_limit'
              ? t('dailyLimit')
              : t('unavailable')}
        </span>
      </p>
      {onRetry ? (
        <div>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {t('retry')}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function Proposals({
  proposals,
  canApply,
  onStatus,
  onRefresh,
}: {
  proposals: ChatProposal[];
  canApply: boolean;
  onStatus: (id: string, status: ProposalStatus) => void;
  onRefresh: () => void;
}) {
  if (proposals.length === 0) return null;
  return (
    <div className="grid w-full max-w-[90%] grid-cols-1 gap-2">
      {proposals.map((p) => (
        <ProposalCard
          key={p.id}
          proposal={p}
          canApply={canApply}
          onStatus={onStatus}
          onRefresh={onRefresh}
        />
      ))}
    </div>
  );
}

/**
 * The conversation: history (older pages on request), the answer being written, and errors.
 * It sticks to the bottom while the member is there; if they scrolled up, a "New messages" pill
 * offers the way back. Older messages are prepended without moving what they are reading.
 */
export function MessageList({
  messages,
  turn,
  error,
  hasMore,
  loadingOlder,
  olderFailed,
  canApply,
  banner,
  empty,
  onLoadOlder,
  onRetry,
  onProposalStatus,
  onRefresh,
}: {
  messages: ChatMessage[];
  turn: ChatTurn | null;
  error: ChatError | null;
  hasMore: boolean;
  loadingOlder: boolean;
  olderFailed: boolean;
  canApply: boolean;
  /** Pinned above the messages (the learning banner). */
  banner?: ReactNode;
  /** Shown instead of the log while there is nothing to show. */
  empty?: ReactNode;
  onLoadOlder: () => void;
  onRetry: (text: string) => void;
  onProposalStatus: (id: string, status: ProposalStatus) => void;
  onRefresh: () => void;
}) {
  const t = useTranslations('advisor');
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const last = useRef<{ first: string | undefined; height: number }>({
    first: undefined,
    height: 0,
  });
  const mountedAt = useRef(Date.now());
  const [pill, setPill] = useState(false);

  const toBottom = () => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // After every render: keep the bottom in view, or keep the reader's place when older messages
  // were prepended, or offer the pill when new content arrived while they read further up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const first = messages[0]?.id;
    const prev = last.current;
    const prepended =
      prev.first !== undefined && first !== prev.first && messages.some((m) => m.id === prev.first);
    if (prepended) el.scrollTop += el.scrollHeight - prev.height;
    else if (stuck.current) el.scrollTop = el.scrollHeight;
    else if (el.scrollHeight > prev.height) setPill(true);
    last.current = { first, height: el.scrollHeight };
  });

  useEffect(() => {
    toBottom();
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (stuck.current) setPill(false);
  };

  const tool = turn?.tool ? (TOOL_LABELS[turn.tool] ?? 'default') : 'default';
  const lastIndex = messages.length - 1;
  const isEmpty = messages.length === 0 && !turn && !error;

  return (
    <div className="relative min-h-0 flex-1 bg-inherit">
      <div
        ref={scroller}
        onScroll={onScroll}
        className="h-full overflow-y-auto overscroll-contain bg-inherit"
      >
        {banner ? <div className="sticky top-0 z-10 bg-inherit p-3">{banner}</div> : null}
        {isEmpty && empty ? (
          empty
        ) : (
          // The log role would replace the list role and orphan the items, so the log is the
          // wrapper and the list stays a list.
          <div role="log" aria-label={t('conversation')} aria-live="off">
            <ol className="flex flex-col gap-3 p-4">
              {hasMore ? (
                <li className="flex flex-col items-center gap-1">
                  <Button variant="ghost" size="sm" disabled={loadingOlder} onClick={onLoadOlder}>
                    {loadingOlder ? t('loadingEarlier') : t('loadEarlier')}
                  </Button>
                  {olderFailed ? (
                    <p role="alert" className="text-caption font-normal text-negative">
                      {t('loadError')}
                    </p>
                  ) : null}
                </li>
              ) : null}
              {messages.map((m, index) => {
                const fresh = m.createdAt.getTime() >= mountedAt.current;
                if (m.role === 'user') {
                  return (
                    <li key={m.id} className={cn('flex justify-end', fresh && ARRIVE)}>
                      <div
                        className={cn(
                          BUBBLE,
                          'max-w-[85%] rounded-xl rounded-br-sm bg-primary text-primary-foreground',
                        )}
                      >
                        <span className="sr-only">{t('speakerYou')}: </span>
                        {m.text}
                      </div>
                    </li>
                  );
                }
                if (m.status === 'failed') {
                  // Only the latest failure matters: an older one was answered by a later turn.
                  if (index !== lastIndex || turn || error) return null;
                  const before = messages
                    .slice(0, index)
                    .reverse()
                    .find((x) => x.role === 'user');
                  return (
                    <li key={m.id} className="flex">
                      <ErrorBubble
                        error="unavailable"
                        onRetry={before ? () => onRetry(before.text) : null}
                      />
                    </li>
                  );
                }
                if (m.status === 'pending') {
                  if (index !== lastIndex || turn) return null;
                  return (
                    <li key={m.id} className="flex">
                      <TypingBubble />
                    </li>
                  );
                }
                return (
                  <li key={m.id} className={cn('flex flex-col items-start gap-2', fresh && ARRIVE)}>
                    {m.origin === 'proactive' ? (
                      <span className="flex items-center gap-1 text-caption text-primary-text">
                        <Bell className="size-3" aria-hidden="true" />
                        {t('proactive')}
                      </span>
                    ) : null}
                    {m.text ? (
                      <div className="max-w-[90%]">
                        <AssistantText text={m.text} proactive={m.origin === 'proactive'} />
                      </div>
                    ) : null}
                    <Proposals
                      proposals={m.proposals}
                      canApply={canApply}
                      onStatus={onProposalStatus}
                      onRefresh={onRefresh}
                    />
                  </li>
                );
              })}
              {turn ? (
                <li className={cn('flex flex-col items-start gap-2', ARRIVE)}>
                  {turn.text ? (
                    <div className="max-w-[90%]">
                      <AssistantText text={turn.text} />
                    </div>
                  ) : (
                    <>
                      <TypingBubble />
                      <p className="flex items-center gap-1.5 text-caption font-normal text-muted-foreground">
                        <Search className="size-3" aria-hidden="true" />
                        {t(`tools.${tool}`)}
                      </p>
                    </>
                  )}
                  <Proposals
                    proposals={turn.proposals}
                    canApply={canApply}
                    onStatus={onProposalStatus}
                    onRefresh={onRefresh}
                  />
                </li>
              ) : null}
              {error ? (
                <li className={cn('flex', ARRIVE)}>
                  <ErrorBubble
                    error={error.code}
                    onRetry={error.retryText !== null ? () => onRetry(error.retryText!) : null}
                  />
                </li>
              ) : null}
            </ol>
          </div>
        )}
      </div>
      {pill ? (
        <button
          type="button"
          onClick={() => {
            stuck.current = true;
            toBottom();
            setPill(false);
          }}
          className="absolute bottom-3 left-1/2 inline-flex h-9 -translate-x-1/2 items-center rounded-full bg-foreground px-4 text-sm font-medium text-background shadow-raised"
        >
          {t('newMessages')}
        </button>
      ) : null}
    </div>
  );
}
