import { and, desc, eq } from 'drizzle-orm';
import { schema, withHousehold, type Db } from '@arfolio/db';
import { NotFoundError, recordAudit, type ServiceCtx } from '@arfolio/services';

/** An OAuth app the user has allowed to act for them (their consent, with the client's own name). */
export type ConnectedApp = {
  clientId: string;
  name: string | null;
  /** Host of the client's first redirect URI: what the consent page falls back to as its name. */
  host: string | null;
  scopes: string[];
  grantedAt: Date;
};

function hostOf(uris: readonly string[] | null): string | null {
  const first = uris?.[0];
  if (!first) return null;
  try {
    return new URL(first).host;
  } catch {
    return null;
  }
}

/** The user's consents, newest first, one row per client. */
export async function listConnectedApps(db: Db, userId: string): Promise<ConnectedApp[]> {
  const rows = await db
    .select({
      clientId: schema.oauthConsent.clientId,
      scopes: schema.oauthConsent.scopes,
      grantedAt: schema.oauthConsent.createdAt,
      name: schema.oauthClient.name,
      redirectUris: schema.oauthClient.redirectUris,
    })
    .from(schema.oauthConsent)
    .innerJoin(schema.oauthClient, eq(schema.oauthClient.clientId, schema.oauthConsent.clientId))
    .where(eq(schema.oauthConsent.userId, userId))
    .orderBy(desc(schema.oauthConsent.createdAt));
  const seen = new Set<string>();
  const apps: ConnectedApp[] = [];
  for (const row of rows) {
    if (seen.has(row.clientId)) continue;
    seen.add(row.clientId);
    apps.push({
      clientId: row.clientId,
      name: row.name?.trim() || null,
      host: hostOf(row.redirectUris),
      scopes: row.scopes,
      grantedAt: row.grantedAt,
    });
  }
  return apps;
}

/**
 * Revokes one app's access for the caller, in one transaction: the consent (the MCP endpoint
 * rejects a token whose consent is gone, so this alone stops access at once), the caller's access
 * and refresh tokens for that client, and an audit row (`consent.revoke`, credential
 * `oauth:<clientId>`). Other users' grants of the same client are untouched. No consent for this
 * user and client is "not found".
 */
export async function revokeConnectedApp(ctx: ServiceCtx, clientId: string): Promise<void> {
  if (clientId.length === 0 || clientId.length > 200) throw new NotFoundError('App');
  await withHousehold(ctx.db, ctx.householdId, async (tx) => {
    const { oauthAccessToken, oauthRefreshToken, oauthConsent } = schema;
    await tx
      .delete(oauthAccessToken)
      .where(and(eq(oauthAccessToken.clientId, clientId), eq(oauthAccessToken.userId, ctx.userId)));
    await tx
      .delete(oauthRefreshToken)
      .where(
        and(eq(oauthRefreshToken.clientId, clientId), eq(oauthRefreshToken.userId, ctx.userId)),
      );
    const removed = await tx
      .delete(oauthConsent)
      .where(and(eq(oauthConsent.clientId, clientId), eq(oauthConsent.userId, ctx.userId)))
      .returning({ id: oauthConsent.id });
    if (removed.length === 0) throw new NotFoundError('App');
    await recordAudit(tx, ctx, {
      actor: 'web',
      action: 'consent.revoke',
      targetType: 'oauth_client',
      targetId: clientId,
      credential: `oauth:${clientId}`,
    });
  });
}
