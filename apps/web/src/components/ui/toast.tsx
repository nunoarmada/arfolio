'use client';

import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/cn';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  message: string;
  tone: 'success' | 'error' | 'info' | 'warning';
  action?: ToastAction;
}

interface ToastApi {
  /** `action` adds a button (e.g. "Anular") for the lifetime of the toast. */
  success: (message: string, action?: ToastAction) => void;
  /** `action` (e.g. "Tentar novamente") stays for the lifetime of the toast. */
  error: (message: string, action?: ToastAction) => void;
  info: (message: string) => void;
  warning: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const TOAST_MS = 6000;

/**
 * Minimal toast stack in a polite live region (no third-party library, so no injected inline
 * styles to fight the strict CSP). Bottom-centre above the tab bar on phones, bottom-right on
 * larger screens.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    held.current.delete(id);
    setItems((cur) => cur.filter((t) => t.id !== id));
  }, []);

  // A toast with a button ("Anular") must not vanish under a mouse pointer or a focused button.
  // Touch has no hover, so only a mouse pointer pauses it; focus pauses it for everyone.
  const held = useRef(new Map<number, { hover: boolean; focus: boolean }>());
  const arm = useCallback(
    (id: number) => {
      window.clearTimeout(timers.current.get(id));
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), TOAST_MS),
      );
    },
    [dismiss],
  );
  const setHeld = useCallback(
    (id: number, part: 'hover' | 'focus', on: boolean) => {
      const state = held.current.get(id) ?? { hover: false, focus: false };
      state[part] = on;
      held.current.set(id, state);
      if (state.hover || state.focus) {
        window.clearTimeout(timers.current.get(id));
        timers.current.delete(id);
      } else {
        arm(id);
      }
    },
    [arm],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const push = useCallback(
    (tone: ToastItem['tone'], message: string, action?: ToastAction) => {
      const id = (nextId.current += 1);
      setItems((cur) => [...cur, { id, message, tone, ...(action ? { action } : {}) }]);
      arm(id);
    },
    [arm],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (m, action) => push('success', m, action),
      error: (m, action) => push('error', m, action),
      info: (m) => push('info', m),
      warning: (m) => push('warning', m),
    }),
    [push],
  );

  return (
    <ToastContext value={api}>
      {children}
      <div
        aria-live="polite"
        className="toast-region pointer-events-none fixed inset-x-4 bottom-[calc(var(--tabbar-height)+env(safe-area-inset-bottom)+0.75rem)] z-[60] flex flex-col items-center gap-2 md:inset-x-auto md:bottom-6 md:right-6 md:items-end"
      >
        {items.map((t) => (
          <div
            key={t.id}
            onPointerEnter={(e) => e.pointerType === 'mouse' && setHeld(t.id, 'hover', true)}
            onPointerLeave={(e) => e.pointerType === 'mouse' && setHeld(t.id, 'hover', false)}
            onFocus={() => setHeld(t.id, 'focus', true)}
            onBlur={() => setHeld(t.id, 'focus', false)}
            role={t.tone === 'error' ? 'alert' : undefined}
            className={cn(
              'pointer-events-auto flex max-w-sm items-center gap-2 rounded-lg bg-surface-raised px-4 py-3 text-sm shadow-raised animate-in fade-in-0 slide-in-from-bottom-2 duration-[260ms]',
            )}
          >
            {t.tone === 'success' ? (
              <CheckCircle2 className="size-5 shrink-0 text-positive" aria-hidden="true" />
            ) : t.tone === 'warning' ? (
              <AlertTriangle className="size-5 shrink-0 text-warning" aria-hidden="true" />
            ) : t.tone === 'info' ? (
              <Info className="size-5 shrink-0 text-transfer" aria-hidden="true" />
            ) : (
              <XCircle className="size-5 shrink-0 text-negative" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1">{t.message}</span>
            {t.action ? (
              <button
                type="button"
                className="-my-2 -mr-2 min-h-11 shrink-0 rounded-md px-3 text-sm font-semibold text-primary hover:bg-surface-2"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </ToastContext>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
