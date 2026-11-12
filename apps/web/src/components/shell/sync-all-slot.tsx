import { countActiveConnections, type ServiceCtx } from '@arfolio/services';
import { cache } from 'react';
import { SyncAllButton } from './sync-all-button';

/** One count per request: the sidebar and the phone top bar both render a slot. */
const activeConnections = cache((service: ServiceCtx) => countActiveConnections(service));

/**
 * The "Sync all" button (sidebar row or phone top bar), streamed on its own (the shell wraps it in Suspense): the connections
 * query must never hold up or break the rest of the shell. If it fails the row is left out and
 * the connections page shows the problem.
 */
export async function SyncAllSlot({
  service,
  variant,
}: {
  service: ServiceCtx;
  variant: 'sidebar' | 'topbar';
}) {
  let active: number;
  try {
    active = await activeConnections(service);
  } catch (error) {
    console.error(`sync all slot: ${error instanceof Error ? error.name : 'unknown'}`);
    return null;
  }
  return active > 0 ? <SyncAllButton variant={variant} /> : null;
}
