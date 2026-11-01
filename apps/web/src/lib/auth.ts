import { and, eq, gt } from 'drizzle-orm';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import { createAccessControl } from 'better-auth/plugins/access';
import { admin, jwt, organization, twoFactor } from 'better-auth/plugins';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { mcp } from '@better-auth/mcp';
import { schema, type Db } from '@arfolio/db';
import { ac, roles } from './access';
import { createAuthHooks } from './auth-guards';
import { getDb } from './db';
import { getEnv, type Env } from './env';
import { isAllowedMcpRedirectUri } from './mcp-redirect';
import { currentUserCreationScope } from './user-creation';

export type AuthEnv = Pick<
  Env,
  'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL' | 'APP_URL' | 'BRAND_NAME'
> &
  Partial<Pick<Env, 'CLIENT_IP_HEADER' | 'MCP_ALLOWED_REDIRECT_URIS'>>;

/** OAuth scopes of the MCP authorization server: identity scopes plus the two household scopes. */
export const MCP_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'pfm:read',
  'pfm:write',
] as const;

// The admin plugin is only used so server code can call auth.api.createUser (which bypasses the
// disabled public sign-up). Its HTTP endpoints must stay unusable for everyone: it gets a role
// table with a single powerless `user` role, so no account can ever pass an admin permission
// check (no `admin` role exists, and `adminUserIds` is empty).
const adminAc = createAccessControl({
  user: [
    'create',
    'list',
    'set-role',
    'ban',
    'impersonate',
    'delete',
    'set-password',
    'get',
    'update',
  ],
  session: ['list', 'revoke', 'delete'],
} as const);
const noAdminRoles = { user: adminAc.newRole({ user: [], session: [] }) };

async function hasPendingInvitation(db: Db, email: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.invitation.id })
    .from(schema.invitation)
    .where(
      and(
        eq(schema.invitation.email, email.toLowerCase()),
        eq(schema.invitation.status, 'pending'),
        gt(schema.invitation.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Builds an auth instance; tests pass their own db and env, the app uses {@link getAuth}. */
export function createAuth({ db, env }: { db: Db; env: AuthEnv }) {
  const extraRedirectUris = env.MCP_ALLOWED_REDIRECT_URIS ?? [];
  return betterAuth({
    appName: env.BRAND_NAME,
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    emailAndPassword: { enabled: true, disableSignUp: true },
    // Rate limits key on the proxy-set header only; X-Forwarded-For is client-controlled.
    advanced: { ipAddress: { ipAddressHeaders: [env.CLIENT_IP_HEADER ?? 'x-real-ip'] } },
    hooks: createAuthHooks(db, { extraRedirectUris }),
    // The session-backed consent endpoints would let a signed-in user rewrite their own consent
    // (the scope rules live in the /oauth2/consent hook only) and /token mints bare session JWTs.
    // Revocation goes through the app's own server action. The token endpoint is /oauth2/token.
    // /oauth2/continue resumes an authorisation after account selection, sign-up or post-login
    // pages, none of which is configured; it would otherwise issue a code from a stored consent
    // without the freshness check (codes are only issued via /oauth2/authorize, /oauth2/consent,
    // /oauth2/continue and right after a sign-in, which creates a fresh session).
    disabledPaths: [
      '/oauth2/update-consent',
      '/oauth2/delete-consent',
      '/oauth2/continue',
      '/token',
    ],
    rateLimit: {
      enabled: true,
      storage: 'memory',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        // Open dynamic client registration: 10 per hour per client IP.
        '/oauth2/register': { window: 3600, max: 10 },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const scope = currentUserCreationScope();
            const allowed =
              scope?.kind === 'setup' ||
              (scope?.kind === 'invitation' &&
                scope.email.toLowerCase() === user.email.toLowerCase() &&
                (await hasPendingInvitation(db, user.email)));
            if (!allowed) {
              throw APIError.from('FORBIDDEN', {
                code: 'SIGN_UP_DISABLED',
                message: 'Accounts are created by setup or invitation only',
              });
            }
          },
        },
      },
    },
    plugins: [
      twoFactor({ issuer: env.BRAND_NAME }),
      organization({
        ac,
        roles,
        creatorRole: 'owner',
        // Households are created by the setup flow (server-side, which is still allowed).
        allowUserToCreateOrganization: false,
      }),
      admin({ ac: adminAc, roles: noAdminRoles }),
      // OAuth 2.1 authorization server for MCP clients (claude.ai connector, Claude Code). `mcp`
      // wraps the OAuth provider, so there is no separate oauthProvider(); tokens are JWTs
      // (jwt() signs them) bound to the MCP resource.
      jwt({ disableSettingJwtHeader: true }),
      mcp({
        resource: `${env.APP_URL}/api/mcp`,
        loginPage: '/sign-in',
        consentPage: '/oauth/consent',
        scopes: [...MCP_SCOPES],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // Native clients (Claude Code) register an http loopback callback without saying so.
        clientRegistrationDefaultApplicationType: 'infer',
        // Clients only come from dynamic registration (open, rate limited, allowlisted redirects):
        // no signed-in user may create, read, update, rotate or delete clients through the
        // session-backed management endpoints.
        clientPrivileges: () => false,
        // No client_credentials: every token belongs to a signed-in household member.
        grantTypes: ['authorization_code', 'refresh_token'],
        accessTokenExpiresIn: 60 * 60,
        refreshTokenExpiresIn: 30 * 24 * 60 * 60,
        // Authorize-time check; registration is checked by the before hook in auth-guards.
        validateRedirectUri: (uri, _registered, defaultResult) =>
          defaultResult && isAllowedMcpRedirectUri(uri, extraRedirectUris),
      }),
      cimd({ fetchClientMetadataResource }),
      nextCookies(), // keep last
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

let cached: Auth | undefined;

/** Lazily built app-wide instance (env and db are read on first use, not at import/build time). */
export function getAuth(): Auth {
  cached ??= createAuth({ db: getDb(), env: getEnv() });
  return cached;
}
