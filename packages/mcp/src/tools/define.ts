import type { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { Tx } from '@arfolio/db';
import { assertCanWrite, recordAudit, type ServiceCtx } from '@arfolio/services';
import type { McpCaller } from '../caller.js';
import { failure, ok, ToolError } from '../errors.js';

/** What a handler gets besides its arguments. */
export type ToolEnv = {
  ctx: ServiceCtx;
  /** Writes this tool's audit row in the caller's open transaction (pass it to `onCommit`). */
  audit: (tx: Tx, action: string, targetType: string, targetId: string) => Promise<void>;
};

export type ToolDef<I extends z.ZodObject, O extends z.ZodObject> = {
  name: string;
  title: string;
  description: string;
  /** `read` needs `pfm:read`; `write` needs `pfm:write` and a role that may write. */
  access: 'read' | 'write';
  input: I;
  output: O;
  handler: (args: z.output<I>, env: ToolEnv) => Promise<z.input<O>>;
};

/** Registers one tool: scope and role checks first, then the handler, errors as tool errors. */
export function defineTool<I extends z.ZodObject, O extends z.ZodObject>(
  server: McpServer,
  caller: McpCaller,
  def: ToolDef<I, O>,
): void {
  const env: ToolEnv = {
    ctx: caller.ctx,
    audit: (tx, action, targetType, targetId) =>
      recordAudit(tx, caller.ctx, {
        actor: 'mcp',
        action,
        targetType,
        targetId,
        credential: caller.credential,
      }),
  };
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.input,
      outputSchema: def.output,
      annotations:
        def.access === 'read'
          ? { readOnlyHint: true, openWorldHint: false }
          : {
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: false,
              openWorldHint: false,
            },
    },
    // The SDK types the callback from the schema; with generic schemas that cannot be resolved here,
    // and the SDK has validated `args` against `def.input` before calling us.
    (async (args: unknown) => {
      try {
        const scope = def.access === 'read' ? 'pfm:read' : 'pfm:write';
        if (!caller.scopes.has(scope)) {
          throw new ToolError('insufficient_scope', `This tool needs the ${scope} scope`);
        }
        if (def.access === 'write') assertCanWrite(caller.ctx);
        return ok((await def.handler(args as z.output<I>, env)) as Record<string, unknown>);
      } catch (error) {
        return failure(def.name, error);
      }
    }) as never,
  );
}

/** Drops keys whose value is undefined, so optional filters are left out of service input. */
export function defined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}
