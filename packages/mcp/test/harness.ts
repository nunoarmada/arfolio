import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { schema } from '@arfolio/db';
import type { McpScope, ServiceCtx } from '@arfolio/services';
import { startServicesDb, type ServicesTestDb } from '../../services/test/helpers.js';
import { createArfolioMcpServer, type McpCaller } from '../src/index.js';

export { startServicesDb, type ServicesTestDb };

export type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

export const caller = (
  ctx: ServiceCtx,
  scopes: McpScope[] = ['pfm:read', 'pfm:write'],
  credential = 'pat:test',
): McpCaller => ({ ctx, scopes: new Set(scopes), credential });

/** A real MCP client talking to a real server over the SDK's in-memory transport. */
export async function connect(c: McpCaller) {
  const server = createArfolioMcpServer(c, { brandName: 'Test', version: '0.0.0' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    client,
    call: async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as ToolResult,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export const errorCode = (r: ToolResult): string | undefined => r.structuredContent?.error?.code;

/** Households in a fresh database plus the user the audit rows reference. */
export async function seedTwoHouseholds(t: ServicesTestDb) {
  await t.owner.insert(schema.user).values({
    id: 'user-1',
    name: 'u',
    email: `u-${randomUUID()}@example.test`,
  });
  return { a: await t.household({ currency: 'EUR' }), b: await t.household({ currency: 'EUR' }) };
}
