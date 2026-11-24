'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadAdvisorStateAction, loadOlderAdvisorMessagesAction } from '@/server/actions/advisor';
import type { AdvisorState } from '@/server/advisor-data';
import {
  ADVISOR_PAGE_SIZE,
  toChatMessage,
  type ChatMessage,
  type ChatProposal,
  type ProposalStatus,
} from './advisor-types';
import { useAdvisorStream, type AdvisorErrorCode } from './use-advisor-stream';

/** How the conversation is doing as a whole. */
export type ChatStatus = 'loading' | 'ready' | 'error' | 'off' | 'not_configured';

/** The answer being written right now. */
export interface ChatTurn {
  text: string;
  proposals: ChatProposal[];
  /** The tool the advisor is using (for the "Looking at your budget…" line). */
  tool: string | null;
}

/** A turn that failed; it is shown in the list but never stored. */
export interface ChatError {
  code: Exclude<AdvisorErrorCode, 'ai_off' | 'not_configured'>;
  /** What to send again; refusals (busy, daily limit) have nothing to retry. */
  retryText: string | null;
}

/** What a screen reader hears when a turn ends: the whole answer, or why there is none. */
export interface Announcement {
  id: number;
  text?: string;
  error?: ChatError['code'];
}

export type SendOptions = { retry?: boolean };

export interface AdvisorChatController {
  status: ChatStatus;
  /** Why the advisor is off (`off` status only); unknown when the server said so while sending. */
  offReason: 'no_key' | 'household_off' | null;
  state: AdvisorState | null;
  messages: ChatMessage[];
  hasMore: boolean;
  loadingOlder: boolean;
  olderFailed: boolean;
  turn: ChatTurn | null;
  streaming: boolean;
  error: ChatError | null;
  announcement: Announcement | null;
  /** Starts a turn; false when none can start (empty text, one already running, not ready). */
  send: (text: string, options?: SendOptions) => boolean;
  loadOlder: () => void;
  setProposalStatus: (id: string, status: ProposalStatus) => void;
  /** Reloads the conversation from the server (silently when it is already showing). */
  refresh: () => Promise<void>;
  /** The history was cleared: the list empties at once, the rest is reloaded. */
  cleared: () => void;
}

const BUSY_NOTICE_MS = 5000;
let localIds = 0;
const localId = () => `local-${(localIds += 1)}`;
const isLocal = (id: string) => id.startsWith('local-');

/**
 * One member's conversation with the advisor: the history, paging older messages, the answer
 * that streams in, and the errors a turn can end with. The window, the sheet and the page share
 * this; pass `initial` when the server already loaded the state (the page).
 */
export function useAdvisorChat({
  initial,
  enabled,
}: {
  initial?: AdvisorState;
  /** Load the conversation (the window waits until it is first opened). */
  enabled: boolean;
}): AdvisorChatController {
  const stream = useAdvisorStream();
  const [state, setState] = useState<AdvisorState | null>(initial ?? null);
  const [status, setStatus] = useState<ChatStatus>(
    initial ? (initial.available ? 'ready' : 'off') : 'loading',
  );
  const [offReason, setOffReason] = useState<'no_key' | 'household_off' | null>(
    initial && !initial.available ? (initial.reason ?? null) : null,
  );
  const [messages, setMessages] = useState<ChatMessage[]>(
    () => initial?.messages.map(toChatMessage) ?? [],
  );
  const [hasMore, setHasMore] = useState(
    initial ? initial.messages.length >= ADVISOR_PAGE_SIZE : false,
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const [turn, setTurn] = useState<ChatTurn | null>(null);
  const [error, setError] = useState<ChatError | null>(null);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);

  const statusRef = useRef(status);
  const messagesRef = useRef(messages);
  const running = useRef(false);
  const loadStarted = useRef(initial !== undefined);
  const announcements = useRef(0);
  const busyTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    statusRef.current = status;
    messagesRef.current = messages;
  });
  useEffect(() => () => window.clearTimeout(busyTimer.current), []);

  const load = useCallback(async (silent: boolean) => {
    if (!silent) setStatus('loading');
    const result = await loadAdvisorStateAction();
    if (!result.ok) {
      if (!silent) setStatus('error');
      return;
    }
    const next = result.data;
    setState(next);
    setMessages(next.messages.map(toChatMessage));
    setHasMore(next.messages.length >= ADVISOR_PAGE_SIZE);
    setOlderFailed(false);
    if (next.available) {
      setOffReason(null);
      setStatus('ready');
    } else {
      setOffReason(next.reason ?? null);
      setStatus('off');
    }
  }, []);

  useEffect(() => {
    if (!enabled || loadStarted.current) return;
    loadStarted.current = true;
    void load(false);
  }, [enabled, load]);

  const refresh = useCallback(() => load(statusRef.current === 'ready'), [load]);

  const send = useCallback(
    (raw: string, options?: SendOptions): boolean => {
      const text = raw.trim();
      if (!text || running.current || statusRef.current !== 'ready') return false;
      running.current = true;
      window.clearTimeout(busyTimer.current);
      setError(null);

      // A retry does not add the member's message a second time while it is still the last one.
      const lastSent = [...messagesRef.current]
        .reverse()
        .find((m) => !(m.role === 'assistant' && m.status === 'failed'));
      const repeat = options?.retry === true && lastSent?.role === 'user' && lastSent.text === text;
      const own = repeat
        ? null
        : {
            id: localId(),
            role: 'user' as const,
            origin: 'chat' as const,
            text,
            status: 'complete' as const,
            createdAt: new Date(),
            proposals: [],
          };
      if (own) setMessages((cur) => [...cur, own]);
      setTurn({ text: '', proposals: [], tool: null });

      let answer = '';
      const proposals: ChatProposal[] = [];
      void stream
        .send(text, (event) => {
          if (event.type === 'text') {
            answer += event.delta;
            setTurn((cur) => (cur ? { ...cur, text: answer, tool: null } : cur));
          } else if (event.type === 'tool') {
            setTurn((cur) => (cur ? { ...cur, tool: event.name } : cur));
          } else {
            proposals.push(event.proposal);
            setTurn((cur) => (cur ? { ...cur, proposals: [...proposals] } : cur));
          }
        })
        .then((outcome) => {
          setTurn(null);
          if (outcome.status === 'aborted') return;
          const announce = (fields: Omit<Announcement, 'id'>) =>
            setAnnouncement({ id: (announcements.current += 1), ...fields });
          if (outcome.status === 'done') {
            setMessages((cur) => [
              ...cur,
              {
                id: outcome.messageId ?? localId(),
                role: 'assistant',
                origin: 'chat',
                text: answer,
                status: 'complete',
                createdAt: new Date(),
                proposals,
              },
            ]);
            if (answer) announce({ text: answer });
            return;
          }
          const { code } = outcome;
          // Refused before anything was stored: the member's message was never sent.
          if (code !== 'unavailable' && own) {
            setMessages((cur) => cur.filter((m) => m.id !== own.id));
          }
          if (code === 'ai_off') {
            setStatus('off');
          } else if (code === 'not_configured') {
            setStatus('not_configured');
          } else {
            setError({ code, retryText: code === 'unavailable' ? text : null });
            announce({ error: code });
            if (code === 'busy') {
              busyTimer.current = window.setTimeout(() => setError(null), BUSY_NOTICE_MS);
            }
          }
        })
        .finally(() => {
          running.current = false;
        });
      return true;
    },
    [stream],
  );

  const loadOlder = useCallback(() => {
    const first = messagesRef.current[0];
    if (!first || isLocal(first.id) || loadingOlder) return;
    setLoadingOlder(true);
    setOlderFailed(false);
    void loadOlderAdvisorMessagesAction(first.id).then((result) => {
      setLoadingOlder(false);
      if (!result.ok) {
        setOlderFailed(true);
        return;
      }
      setMessages((cur) => [...result.data.map(toChatMessage), ...cur]);
      setHasMore(result.data.length >= ADVISOR_PAGE_SIZE);
    });
  }, [loadingOlder]);

  const setProposalStatus = useCallback((id: string, next: ProposalStatus) => {
    setMessages((cur) =>
      cur.map((m) =>
        m.proposals.some((p) => p.id === id)
          ? { ...m, proposals: m.proposals.map((p) => (p.id === id ? { ...p, status: next } : p)) }
          : m,
      ),
    );
  }, []);

  const cleared = useCallback(() => {
    setMessages([]);
    setHasMore(false);
    setError(null);
    void load(true);
  }, [load]);

  return {
    status,
    offReason,
    state,
    messages,
    hasMore,
    loadingOlder,
    olderFailed,
    turn,
    streaming: turn !== null,
    error,
    announcement,
    send,
    loadOlder,
    setProposalStatus,
    refresh,
    cleared,
  };
}
