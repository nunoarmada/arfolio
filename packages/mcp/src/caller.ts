import type { McpScope, ServiceCtx } from '@arfolio/services';

/**
 * Who is calling a tool. The transport resolves it once per request: `ctx` carries the household
 * and the role read fresh from the membership, `scopes` what the credential was granted, and
 * `credential` names it for the audit log (`pat:<id>` or `oauth:<clientId>`).
 */
export type McpCaller = {
  ctx: ServiceCtx;
  scopes: ReadonlySet<McpScope>;
  credential: string;
};
