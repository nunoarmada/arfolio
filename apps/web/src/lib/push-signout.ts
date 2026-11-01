/** Sign-out never waits on push longer than this. */
export const SIGN_OUT_PUSH_TIMEOUT_MS = 2000;

export interface SignOutPushDeps {
  /** This browser's push subscription, or null when it has none (or no service worker). */
  getSubscription: () => Promise<{ endpoint: string; unsubscribe: () => Promise<boolean> } | null>;
  /** Deletes the server row of this endpoint (needs the session, so it runs before sign-out). */
  releaseOnServer: (endpoint: string) => Promise<unknown>;
}

const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : 'unknown error';

/**
 * Best effort, bounded: before signing out, this device stops receiving the household's alerts, so
 * the next person on a shared tablet does not see them. The server row goes first, then the browser
 * subscription (a failed server call still drops the browser side; the dead endpoint is pruned on
 * the first 404/410). Never rejects and never takes longer than SIGN_OUT_PUSH_TIMEOUT_MS. Only the
 * error name is logged: messages can carry the endpoint, which is a capability URL.
 */
export async function releasePushSubscription(deps: SignOutPushDeps): Promise<void> {
  const work = (async () => {
    const subscription = await deps.getSubscription();
    if (!subscription) return;
    try {
      await deps.releaseOnServer(subscription.endpoint);
    } catch (error) {
      console.error(`push release on the server failed: ${errorName(error)}`);
    }
    await subscription.unsubscribe();
  })().catch((error: unknown) => {
    console.error(`push release on sign-out failed: ${errorName(error)}`);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SIGN_OUT_PUSH_TIMEOUT_MS);
  });
  try {
    await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}
