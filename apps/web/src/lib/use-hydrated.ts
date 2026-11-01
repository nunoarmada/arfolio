'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/**
 * False on the server and during hydration, true once React has taken over on the client.
 * Forms that carry secrets keep their submit button disabled until then: together with
 * `method="post"` this means a tap before hydration never submits (and never reaches the
 * address bar), and a disabled default button also blocks submit-on-Enter.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
