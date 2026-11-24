'use client';

import { usePathname } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useMediaQuery } from '../use-media-query';

/** The window is a floating panel from md up (see the `md` breakpoint) and a sheet below it. */
export const ADVISOR_DESKTOP_QUERY = '(min-width: 48rem)';
const STORAGE_KEY = 'advisor-open';
/** Launcher (56px) and window (400px) sit this far from the corner; toasts make room for both. */
const TOAST_ABOVE_LAUNCHER = 'calc(1.5rem + 3.5rem + 0.75rem)';
const TOAST_LEFT_OF_WINDOW = 'calc(1.5rem + 400px + 1rem)';

export interface OpenOptions {
  /** A question to send as soon as the conversation is ready (the Home card chips). */
  question?: string;
  /** Where focus goes when the window closes (the chip that opened it); default: the launcher. */
  returnFocus?: HTMLElement | null;
}

interface AdvisorState {
  /** The AI gate is open: launcher, Home card and More row exist only then. */
  available: boolean;
  unreadProactive: boolean;
  /** Owners and members may apply proposals; viewers only read them. */
  canApply: boolean;
  isOwner: boolean;
  brandName: string;
  open: boolean;
  /** The window has been opened at least once: only then does it load the conversation. */
  everOpened: boolean;
  /** md and up: a floating window; below: a sheet. */
  desktop: boolean;
  /** On /advisor itself the page is the chat: no launcher, no window. */
  onAdvisorPage: boolean;
  launcherRef: RefObject<HTMLButtonElement | null>;
  pendingQuestion: string | null;
  openAdvisor: (options?: OpenOptions) => void;
  closeAdvisor: (options?: { restoreFocus?: boolean }) => void;
  consumeQuestion: () => string | null;
  /** Puts focus back where the window was opened from (or on the launcher). */
  restoreFocus: () => void;
}

const Context = createContext<AdvisorState | null>(null);

/**
 * The advisor's state for the signed-in shell: whether it exists, whether its window is open and
 * who opened it. It lives in the layout, so the window stays open (and keeps its conversation)
 * across navigation, and survives a reload through sessionStorage.
 */
export function AdvisorProvider({
  available,
  unreadProactive,
  canApply,
  isOwner,
  brandName,
  children,
}: {
  available: boolean;
  unreadProactive: boolean;
  canApply: boolean;
  isOwner: boolean;
  brandName: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const onAdvisorPage = pathname === '/advisor' || pathname.startsWith('/advisor/');
  const desktop = useMediaQuery(ADVISOR_DESKTOP_QUERY);
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const skipRestore = useRef(false);
  const question = useRef<string | null>(null);

  // A reload keeps the floating window open; a phone never reopens a full-screen sheet by itself.
  useEffect(() => {
    try {
      if (
        available &&
        window.sessionStorage.getItem(STORAGE_KEY) === '1' &&
        window.matchMedia(ADVISOR_DESKTOP_QUERY).matches
      ) {
        setOpen(true);
        setEverOpened(true);
      }
    } catch {
      // Storage can be blocked (private windows): the window just starts closed.
    }
  }, [available]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, open ? '1' : '0');
    } catch {
      // Not remembering is harmless.
    }
  }, [open]);

  const openAdvisor = useCallback(
    (options?: OpenOptions) => {
      if (!available) return;
      returnFocus.current = options?.returnFocus ?? null;
      skipRestore.current = false;
      if (options?.question) {
        question.current = options.question;
        setPendingQuestion(options.question);
      }
      setEverOpened(true);
      setOpen(true);
    },
    [available],
  );

  const closeAdvisor = useCallback((options?: { restoreFocus?: boolean }) => {
    skipRestore.current = options?.restoreFocus === false;
    setOpen(false);
  }, []);

  const consumeQuestion = useCallback(() => {
    const value = question.current;
    question.current = null;
    setPendingQuestion(null);
    return value;
  }, []);

  const restoreFocus = useCallback(() => {
    if (skipRestore.current) {
      skipRestore.current = false;
      return;
    }
    const target = returnFocus.current?.isConnected ? returnFocus.current : launcherRef.current;
    returnFocus.current = null;
    target?.focus();
  }, []);

  // Toasts share the bottom-right corner: above the launcher, or beside the open window.
  useEffect(() => {
    const root = document.documentElement;
    const show = available && desktop && !onAdvisorPage;
    if (show && open) root.style.setProperty('--toast-right', TOAST_LEFT_OF_WINDOW);
    else root.style.removeProperty('--toast-right');
    if (show && !open) root.style.setProperty('--toast-bottom', TOAST_ABOVE_LAUNCHER);
    else root.style.removeProperty('--toast-bottom');
    return () => {
      root.style.removeProperty('--toast-right');
      root.style.removeProperty('--toast-bottom');
    };
  }, [available, desktop, onAdvisorPage, open]);

  const value = useMemo<AdvisorState>(
    () => ({
      available,
      unreadProactive,
      canApply,
      isOwner,
      brandName,
      open: available && open,
      everOpened,
      desktop,
      onAdvisorPage,
      launcherRef,
      pendingQuestion,
      openAdvisor,
      closeAdvisor,
      consumeQuestion,
      restoreFocus,
    }),
    [
      available,
      unreadProactive,
      canApply,
      isOwner,
      brandName,
      open,
      everOpened,
      desktop,
      onAdvisorPage,
      pendingQuestion,
      openAdvisor,
      closeAdvisor,
      consumeQuestion,
      restoreFocus,
    ],
  );
  return <Context value={value}>{children}</Context>;
}

export function useAdvisor(): AdvisorState {
  const value = useContext(Context);
  if (!value) throw new Error('useAdvisor must be used inside AdvisorProvider');
  return value;
}
