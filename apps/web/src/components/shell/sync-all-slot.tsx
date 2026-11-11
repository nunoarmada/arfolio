import { countActiveConnections, type ServiceCtx } from '@arfolio/services';
import { SyncAllButton } from './sync-all-button';

/**
 * The "Sync all" row, streamed on its own (the shell wraps it in Suspense): the connections
 * query must never hold up or break the rest of the shell. If it fails the row is left out and
 * the connections page shows the problem.
 */
export async function SyncAllSlot({ service }: { service: ServiceCtx }) {
  let active: number;
  try {
    active = await countActiveConnections(service);
  } catch (error) {
    console.error(`sync all slot: ${error instanceof Error ? error.name : 'unknown'}`);
    return null;
  }
  return active > 0 ? <SyncAllButton /> : null;
}
