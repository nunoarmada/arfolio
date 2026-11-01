import {
  ensureHouseholdDefaults,
  listAccounts,
  listCategories,
  type ServiceCtx,
} from '@arfolio/services';
import {
  toAccountDto,
  toGroupDtos,
  type AccountDto,
  type CategoryDto,
  type GroupDto,
} from './serialize';

export interface Lookups {
  accounts: AccountDto[];
  groups: GroupDto[];
  categories: CategoryDto[];
}

/** Accounts (with balances) and categories, archived ones included so old rows still resolve. */
export async function loadLookups(ctx: ServiceCtx): Promise<Lookups> {
  // Self-heal a household created before the default categories existed, before they are listed.
  await ensureHouseholdDefaults(ctx);
  const [accounts, groups] = await Promise.all([
    listAccounts(ctx, { includeArchived: true }),
    listCategories(ctx, { includeArchived: true }),
  ]);
  const groupDtos = toGroupDtos(groups);
  return {
    accounts: accounts.map(toAccountDto),
    groups: groupDtos,
    categories: groupDtos.flatMap((g) => g.categories),
  };
}
