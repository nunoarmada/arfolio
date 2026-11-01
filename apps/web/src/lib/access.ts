import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/organization/access';

export const ROLES = ['owner', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * The organisation plugin's own resources (household = organisation) plus app-level ones:
 * `billing`, and `data` for accounts, transactions, budgets and the rest of the household's data.
 */
export const statement = {
  ...defaultStatements,
  billing: ['read', 'manage'],
  data: ['read', 'write'],
} as const;

export const ac = createAccessControl(statement);

/** Everything. */
export const owner = ac.newRole({
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  billing: ['read', 'manage'],
  data: ['read', 'write'],
});

/**
 * Everything except members, billing and household deletion. No `organization:update`: renaming
 * (and the logo, slug and metadata) is owner-only, see updateHouseholdName.
 */
export const member = ac.newRole({
  data: ['read', 'write'],
});

/** Read-only. */
export const viewer = ac.newRole({
  data: ['read'],
});

export const roles = { owner, member, viewer };
