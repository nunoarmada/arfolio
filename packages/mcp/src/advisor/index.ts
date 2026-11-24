// The advisor without the MCP server: the worker imports this entry so its bundle does not pull
// in the MCP SDK it never uses.
export { createAdvisorClient } from './client.js';
export type { AdvisorModelClient } from './client.js';
export { AdvisorUnavailableError, runAdvisorTurn } from './engine.js';
export type {
  AdvisorProposalView,
  AdvisorTurnDeps,
  AdvisorTurnEvent,
  TurnInput,
} from './engine.js';
