'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatMoneyFor, type FormatMoney } from '@/lib/money-privacy';
import { privacyFromCookies } from '@/lib/privacy-setting';

interface Privacy {
  /** True when amounts are masked. */
  hidden: boolean;
  /** Shows the new state at once; saving it is the caller's job (see `PrivacyToggle`). */
  setHidden: (hidden: boolean) => void;
}

const Context = createContext<Privacy | null>(null);

/**
 * Privacy mode for the signed-in shell. The layout seeds it from the cookie, so the first render is
 * already masked. When the tab comes back into view and another tab has changed the setting, the
 * page reloads, so client and server-rendered amounts follow it together.
 */
export function PrivacyProvider({
  initialHidden,
  children,
}: {
  initialHidden: boolean;
  children: ReactNode;
}) {
  const [hidden, setHidden] = useState(initialHidden);
  const current = useRef(hidden);
  useEffect(() => {
    current.current = hidden;
  }, [hidden]);
  useEffect(() => {
    const sync = () => {
      if (document.visibilityState !== 'visible') return;
      if (privacyFromCookies(document.cookie) !== current.current) window.location.reload();
    };
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);
  return <Context value={{ hidden, setHidden }}>{children}</Context>;
}

export function usePrivacy(): Privacy {
  const value = useContext(Context);
  if (!value) throw new Error('usePrivacy must be used inside PrivacyProvider');
  return value;
}

/** The money formatter for client components: same signature as `formatMoney`, masked when hidden. */
export function useFormatMoney(): FormatMoney {
  return formatMoneyFor(usePrivacy().hidden);
}
