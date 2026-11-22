import type { ActionResult } from '@/server/actions/result';

/**
 * Runs a server action of the import wizard and turns a request that never got an answer (a
 * reverse proxy timing out, the network dropping) into a failure with `reason`, so the wizard
 * shows its message and keeps its state instead of reaching the error boundary. A request that
 * waits for the model reports `ai_timeout`; any other reports `connection_lost`.
 */
export async function orConnectionLost<T>(
  call: () => Promise<ActionResult<T>>,
  reason: 'ai_timeout' | 'connection_lost',
): Promise<ActionResult<T>> {
  try {
    return await call();
  } catch {
    // Nothing came back to read: the failure is reported by what the request was waiting for.
    return { ok: false, code: 'validation', reason, fields: [] };
  }
}
