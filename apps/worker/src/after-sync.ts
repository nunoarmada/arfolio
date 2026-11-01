export type AfterSyncStep = (householdId: string) => Promise<void>;

/**
 * Runs the post-sync steps (queueing AI work) side by side. One failing step is logged by name
 * and error class only, and never stops the others or the sync that called it.
 */
export function afterSyncAll(
  steps: Array<[name: string, run: AfterSyncStep]>,
  logger: { warn(message: string): void },
): AfterSyncStep {
  return async (householdId) => {
    const results = await Promise.allSettled(steps.map(([, run]) => run(householdId)));
    results.forEach((result, i) => {
      if (result.status !== 'rejected') return;
      const label = result.reason instanceof Error ? result.reason.name : 'unknown';
      logger.warn(`after-sync step ${steps[i]![0]} failed: ${label}`);
    });
  };
}
