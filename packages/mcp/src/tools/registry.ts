import type { AnyToolDef } from './define.js';
import { getBudgetVsActualTool } from './budget.js';
import { getNetWorthTool } from './net-worth.js';
import { getOverviewTool } from './overview.js';
import { listAccountsTool, listCategoriesTool } from './reference.js';
import { listReviewInboxTool, searchTransactionsTool } from './transactions.js';

/** The read-only household tools: shared by the MCP server and the in-app advisor. */
export const READ_TOOLS: AnyToolDef[] = [
  getOverviewTool,
  listAccountsTool,
  getNetWorthTool,
  getBudgetVsActualTool,
  searchTransactionsTool,
  listCategoriesTool,
  listReviewInboxTool,
];
