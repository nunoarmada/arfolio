import { and, eq, inArray } from 'drizzle-orm';
import { schema, withHousehold } from '@arfolio/db';
import { listAudit, listMyPats, type ServiceCtx } from '@arfolio/services';
import { getDb } from '../lib/db';
import { ACTIVITY_LIMIT } from '../lib/integrations';
import { listConnectedApps } from './oauth-apps';

export interface TokenDto {
  id: string;
  name: string;
  scope: 'read' | 'read_write';
  prefix: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface AppDto {
  clientId: string;
  name: string | null;
  host: string | null;
  write: boolean;
  grantedAt: string;
}

export type ActivityVia =
  { kind: 'token'; name: string | null } | { kind: 'app'; client: string } | { kind: 'web' };

export interface ActivityDto {
  id: string;
  action: string;
  /** The member's name; null when the account was deleted. */
  who: string | null;
  via: ActivityVia;
  at: string;
}

export interface IntegrationsData {
  /** Each part is null when it could not be loaded: one failure never blanks the page. */
  tokens: TokenDto[] | null;
  apps: AppDto[] | null;
  /** Undefined for anyone but an owner (the section is not rendered at all). */
  activity: ActivityDto[] | null | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Logs the error name only (messages can carry fragments of credentials) and yields null. */
function failed(what: string) {
  return (error: unknown): null => {
    console.error(
      `integrations ${what} failed to load: ${error instanceof Error ? error.name : 'unknown error'}`,
    );
    return null;
  };
}

/**
 * Active (not revoked) tokens of the caller: live ones newest first, then the expired ones.
 * Revoked tokens are not listed; the audit log keeps them.
 */
async function loadTokens(ctx: ServiceCtx): Promise<TokenDto[]> {
  const now = Date.now();
  const rows = (await listMyPats(ctx)).filter((p) => p.revokedAt === null);
  const expired = (p: { expiresAt: Date | null }) =>
    p.expiresAt !== null && p.expiresAt.getTime() <= now;
  return [...rows.filter((p) => !expired(p)), ...rows.filter(expired)].map((p) => ({
    id: p.id,
    name: p.name,
    scope: p.scope,
    prefix: p.prefix,
    expiresAt: p.expiresAt?.toISOString() ?? null,
    lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
  }));
}

async function loadApps(ctx: ServiceCtx): Promise<AppDto[]> {
  const apps = await listConnectedApps(ctx.db, ctx.userId);
  return apps.map((a) => ({
    clientId: a.clientId,
    name: a.name,
    host: a.host,
    write: a.scopes.includes('pfm:write'),
    grantedAt: a.grantedAt.toISOString(),
  }));
}

/** The last 50 audit rows with the member, token and app names resolved (owners only). */
async function loadActivity(ctx: ServiceCtx): Promise<ActivityDto[]> {
  const { items } = await listAudit(ctx, { limit: ACTIVITY_LIMIT });
  const patIds = new Set<string>();
  const clientIds = new Set<string>();
  const userIds = new Set<string>();
  for (const row of items) {
    if (row.userId) userIds.add(row.userId);
    if (row.actor === 'mcp' && row.credential) {
      const sep = row.credential.indexOf(':');
      const kind = row.credential.slice(0, sep);
      const id = row.credential.slice(sep + 1);
      if (kind === 'pat' && UUID.test(id)) patIds.add(id);
      if (kind === 'oauth') clientIds.add(id);
    }
  }
  const db = getDb();
  const [users, pats, clients] = await Promise.all([
    userIds.size
      ? db
          .select({ id: schema.user.id, name: schema.user.name })
          .from(schema.user)
          .where(inArray(schema.user.id, [...userIds]))
      : [],
    patIds.size
      ? withHousehold(db, ctx.householdId, (tx) =>
          tx
            .select({ id: schema.personalAccessToken.id, name: schema.personalAccessToken.name })
            .from(schema.personalAccessToken)
            .where(
              and(
                eq(schema.personalAccessToken.householdId, ctx.householdId),
                inArray(schema.personalAccessToken.id, [...patIds]),
              ),
            ),
        )
      : [],
    clientIds.size
      ? db
          .select({ id: schema.oauthClient.clientId, name: schema.oauthClient.name })
          .from(schema.oauthClient)
          .where(inArray(schema.oauthClient.clientId, [...clientIds]))
      : [],
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const patName = new Map(pats.map((p) => [p.id, p.name]));
  const clientName = new Map(clients.map((c) => [c.id, c.name?.trim() || null]));

  return items.map((row): ActivityDto => {
    let via: ActivityVia = { kind: 'web' };
    // A web action is the web app's even when it names a credential (revoking an app).
    if (row.actor === 'mcp' && row.credential) {
      const sep = row.credential.indexOf(':');
      const kind = row.credential.slice(0, sep);
      const id = row.credential.slice(sep + 1);
      if (kind === 'pat') via = { kind: 'token', name: patName.get(id) ?? null };
      else if (kind === 'oauth') via = { kind: 'app', client: clientName.get(id) ?? id };
    }
    return {
      id: row.id,
      action: row.action,
      who: row.userId ? (userName.get(row.userId) ?? null) : null,
      via,
      at: row.createdAt.toISOString(),
    };
  });
}

/** Everything the integrations page shows. Each part fails on its own. */
export async function loadIntegrations(ctx: ServiceCtx): Promise<IntegrationsData> {
  const [tokens, apps, activity] = await Promise.all([
    loadTokens(ctx).catch(failed('tokens')),
    loadApps(ctx).catch(failed('apps')),
    ctx.role === 'owner' ? loadActivity(ctx).catch(failed('activity')) : undefined,
  ]);
  return { tokens, apps, activity };
}
