import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { listAccounts, listCategories } from '@arfolio/services';
import type { McpCaller } from '../caller.js';
import { accountSchema, categoryGroupSchema, toAccount, toCategoryGroup } from '../dto.js';
import { defineTool } from './define.js';

export function registerReference(server: McpServer, caller: McpCaller): void {
  defineTool(server, caller, {
    name: 'list_accounts',
    title: 'List accounts',
    description:
      'The household’s accounts with their current balance (decimal string plus currency, and ' +
      '`amount_minor`). Archived accounts are left out unless `include_archived` is true. Use the ' +
      'returned ids as `account_id` / `account_ids` in other tools.',
    access: 'read',
    input: z.strictObject({ include_archived: z.boolean().optional() }),
    output: z.object({ accounts: z.array(accountSchema) }),
    handler: async ({ include_archived }, { ctx }) => ({
      accounts: (await listAccounts(ctx, { includeArchived: include_archived ?? false })).map(
        toAccount,
      ),
    }),
  });

  defineTool(server, caller, {
    name: 'list_categories',
    title: 'List categories',
    description:
      'The household’s category groups with their categories. Use the returned category ids as ' +
      '`category_id` / `category_ids` in other tools. Archived ones are left out unless ' +
      '`include_archived` is true. The transfer category cannot be assigned by hand.',
    access: 'read',
    input: z.strictObject({ include_archived: z.boolean().optional() }),
    output: z.object({ groups: z.array(categoryGroupSchema) }),
    handler: async ({ include_archived }, { ctx }) => ({
      groups: (await listCategories(ctx, { includeArchived: include_archived ?? false })).map(
        toCategoryGroup,
      ),
    }),
  });
}
