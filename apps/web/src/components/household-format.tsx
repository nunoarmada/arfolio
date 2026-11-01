'use client';

import { createContext, useContext, type ReactNode } from 'react';

/** How this household reads money and dates (from its settings, never a hard-coded default). */
export interface HouseholdFormat {
  locale: string;
  timeZone: string;
  currency: string;
}

const Context = createContext<HouseholdFormat | null>(null);

export function HouseholdFormatProvider({
  value,
  children,
}: {
  value: HouseholdFormat;
  children: ReactNode;
}) {
  return <Context value={value}>{children}</Context>;
}

export function useHouseholdFormat(): HouseholdFormat {
  const value = useContext(Context);
  if (!value) throw new Error('useHouseholdFormat must be used inside HouseholdFormatProvider');
  return value;
}
