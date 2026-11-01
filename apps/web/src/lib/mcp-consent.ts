import { eq } from 'drizzle-orm';
import { schema, type Db } from '@arfolio/db';

/** Scopes that change household data; only roles that can write may grant them. */
const WRITE_SCOPE = 'pfm:write';
const WRITER_ROLES = new Set(['owner', 'member']);

export type McpHousehold =
  | { kind: 'resolved'; householdId: string; name: string; role: string }
  | { kind: 'unresolved'; memberships: number };

/**
 * The household an OAuth grant is for: the user's only membership. Zero or several memberships
 * are `unresolved`; consent is refused rather than guessing (the MCP route answers the same).
 */
export async function resolveMcpHousehold(db: Db, userId: string): Promise<McpHousehold> {
  const rows = await db
    .select({
      householdId: schema.member.organizationId,
      role: schema.member.role,
      name: schema.organization.name,
    })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .where(eq(schema.member.userId, userId));
  const [only] = rows;
  if (rows.length !== 1 || !only) return { kind: 'unresolved', memberships: rows.length };
  return { kind: 'resolved', ...only };
}

/** The requested scopes a user with this role may be granted (`pfm:write` needs a writer role). */
export function grantableScopes(requested: readonly string[], role: string): string[] {
  return requested.filter((scope) => scope !== WRITE_SCOPE || WRITER_ROLES.has(role));
}
