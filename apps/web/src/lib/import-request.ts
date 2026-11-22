import type { ActionResult } from '@/server/actions/result';

/**
 * Runs a server action of the PDF import and turns a request that never got an answer (a reverse
 * proxy timing out, the network dropping) into the AI timeout failure, so the wizard shows its
 * message and keeps its state instead of reaching the error boundary.
 */
export async function orConnectionLost<T>(
  call: () => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  try {
    return await call();
  } catch {
    // Nothing came back to read: the failure is reported as the timeout it most likely was.
    return { ok: false, code: 'validation', reason: 'ai_timeout', fields: [] };
  }
}
