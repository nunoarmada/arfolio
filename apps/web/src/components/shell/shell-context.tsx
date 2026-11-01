'use client';

import { createContext, useContext, type ReactNode } from 'react';

interface ShellState {
  /** Notifications this member has not read yet (the layout re-renders it on navigation). */
  unread: number;
}

const Context = createContext<ShellState | null>(null);

/** Gives the page header (mobile top bar) what the shell knows, so no page has to pass it. */
export function ShellProvider({ value, children }: { value: ShellState; children: ReactNode }) {
  return <Context value={value}>{children}</Context>;
}

/** Null outside the signed-in shell (the import wizard, auth pages). */
export function useShell(): ShellState | null {
  return useContext(Context);
}
