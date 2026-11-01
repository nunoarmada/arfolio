import { McpServer } from '@modelcontextprotocol/server';
import type { McpCaller } from './caller.js';
import { registerBudget } from './tools/budget.js';
import { registerNetWorth } from './tools/net-worth.js';
import { registerOverview } from './tools/overview.js';
import { registerReference } from './tools/reference.js';
import { registerTransactionTools } from './tools/transactions.js';
import { registerAssetAndRuleTools } from './tools/writes.js';

/**
 * The household tools for one authenticated caller. There is no household argument anywhere:
 * every tool acts on `caller.ctx`, through the services (and so inside `withHousehold`).
 */
export function createArfolioMcpServer(
  caller: McpCaller,
  opts: { brandName: string; version: string },
): McpServer {
  const server = new McpServer({
    name: opts.brandName,
    title: opts.brandName,
    version: opts.version,
  });
  registerOverview(server, caller);
  registerReference(server, caller);
  registerTransactionTools(server, caller);
  registerBudget(server, caller);
  registerNetWorth(server, caller);
  registerAssetAndRuleTools(server, caller);
  return server;
}
