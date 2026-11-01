# API cheat-sheet (verified 2026-10-18)

Method: packages installed into a scratch dir (`npm i --legacy-peer-deps`; plain `npm i` failed with an npm arborist "edgesOut" error, so use `--legacy-peer-deps` or pnpm) and read from README / .d.ts / bundled docs. Paths below are relative to `node_modules/`. Items marked (UNVERIFIED) were not confirmed from the installed package.
Vendor docs sites (better-auth.com, serwist.pages.dev) were unreachable (DNS); ts.sdk.modelcontextprotocol.io was reachable.

## 0. Versions (npm `latest`) and peers

| Package | Version | Notes / peers |
|---|---|---|
| next | 16.4.2 | node >=20.9; react ^18.2 or ^19; Turbopack is default for dev AND build |
| react / react-dom | 19.3.1 | |
| better-auth | 1.7.10 | peers all optional (next ^14-16, drizzle-orm ^0.45.2 or >=1.0.0-rc.1, drizzle-kit >=0.31.4, pg ^8, vitest ^2-5) |
| auth (CLI) | 1.7.10 | **replaces** `@better-auth/cli` (stale at 1.4.21). node >=22.12 |
| @better-auth/oauth-provider | 1.7.10 | OAuth 2.1/OIDC provider plugin |
| @better-auth/mcp | 1.7.10 | `mcp()` plugin + `requireMcpAuth`; replaces old `mcp` plugin in `better-auth/plugins` |
| drizzle-orm | 0.45.4 (latest) | 1.0.0-rc.4/rc.5 exist under `rc` tag; stay on 0.45.x |
| drizzle-kit | 0.31.11 (latest) | rc tag 1.0.0-rc.4 |
| pg | 8.23.1 (+ @types/pg 8.23.1) | |
| pg-boss | 12.38.0 | **node >=22.12**, ESM-only, PG >=13 |
| next-intl | 4.14.9 | peers next ^12..^16 |
| @serwist/next | 9.5.13 | peers next >=14, react >=18, ts >=5, optional @serwist/cli ^9.5.13; webpack-only |
| @serwist/turbopack | 9.5.13 | Turbopack route-handler mode (labelled experimental); peers esbuild >=0.25, esbuild-wasm |
| serwist | 9.5.13 | sw runtime |
| tailwindcss / @tailwindcss/postcss | 4.3.3 | |
| shadcn (CLI) | 4.22.0 | |
| @modelcontextprotocol/server | 2.3.1 | **v2 SDK, stable; new package** (spec 2026-07-28) |
| @modelcontextprotocol/node | 2.1.1 | peer server ^2.3.0 (Node req/res adapter) |
| @modelcontextprotocol/sdk | 1.32.1 | v1 line, still `latest` on npm; avoid for new code |
| @anthropic-ai/sdk | 0.135.0 | peer zod ^3.25 or ^4 (optional) |
| vitest | 5.0.5 | node ^22.12 / 24 / >=26; **vite is a peer: install `vite` (^6.4/7/8) yourself**; @types/node ^22 or >=24 |
| zod | 4.6.7 | `zod` root is v4; `zod/v4` subpath still exported |
| web-push | 3.6.7 (+ @types/web-push 3.6.4) | |
| otplib 13.5.0 / argon2 0.45.1 | not needed | better-auth twoFactor does TOTP; default hashing is scrypt |

## 1. Next.js 16.4 (docs bundled: `next/dist/docs/01-app/02-guides/upgrading/version-16.md`)
- `middleware.ts` -> **`proxy.ts`**, exported function `proxy` (named or default). Node.js runtime only, cannot set `runtime`. `middleware` still works but deprecated (and is the only way to keep edge). Config flags renamed (`skipMiddlewareUrlNormalize` -> `skipProxyUrlNormalize`). Treat proxy as optimistic checks only (no DB-heavy auth).
```ts
// proxy.ts
import { NextResponse, type NextRequest } from 'next/server'
export function proxy(req: NextRequest) { return NextResponse.next() }
export const config = { matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'] }
```
- Turbopack default for `next dev` and `next build`. A custom `webpack` config makes `next build` FAIL unless `--webpack` (or `--turbopack` to ignore it). Plugins that inject `webpack` (e.g. @serwist/next) trigger this.
- Sync access fully removed: `await cookies()`, `await headers()`, `await draftMode()`, `await params`, `await searchParams`.
- Route handler typing: global helper `RouteContext<'/users/[id]'>` (after type gen):
```ts
export async function GET(_req: NextRequest, ctx: RouteContext<'/users/[id]'>) { const { id } = await ctx.params }
```
- `output: 'standalone'` unchanged (`next.config.ts`: `{ output: 'standalone' }` -> `.next/standalone/server.js`; copy `public` and `.next/static` manually).
- Removed: `next lint` and `eslint` config key (run eslint/biome directly), AMP, `serverRuntimeConfig/publicRuntimeConfig`, `experimental.dynamicIO`->`cacheComponents`. Node >=20.9, TS >=5.1. `revalidateTag` now takes a cacheLife profile arg; new `updateTag`, `refresh`. `images.*` defaults changed (minimumCacheTTL, imageSizes, qualities, local IP block).
- Parallel routes need explicit `default.js`.

## 2. better-auth 1.7.10
Imports: `better-auth`, `better-auth/adapters/drizzle`, `better-auth/next-js`, `better-auth/plugins` (`twoFactor`, `organization`, `admin`, `jwt`), `better-auth/plugins/access` (`createAccessControl`), `better-auth/react`, `better-auth/client/plugins`.
```ts
// lib/auth.ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { nextCookies } from 'better-auth/next-js'
import { twoFactor, organization, admin } from 'better-auth/plugins'
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg', schema }),   // opts: usePlural, camelCase, transaction (@better-auth/drizzle-adapter d.ts)
  emailAndPassword: { enabled: true, disableSignUp: true },
  plugins: [twoFactor({ issuer: 'Arfolio' }), organization({ /*...*/ }), admin(), nextCookies() /* keep LAST */],
})
// app/api/auth/[...all]/route.ts
import { toNextJsHandler } from 'better-auth/next-js'
export const { GET, POST } = toNextJsHandler(auth)   // also returns PATCH/PUT/DELETE
```
- **Schema generation**: `npx auth@latest generate --output ./db/auth-schema.ts` (flags: `--config`, `--adapter drizzle`, `--dialect postgresql`, `-y`) (auth/README.md). Then `drizzle-kit generate`. `migrate` is Kysely-only. Other commands: `init`, `secret`, `create-admin --email --name --role`.
- Password hashing: **scrypt** via `@better-auth/utils/password` (node:crypto). Override with `emailAndPassword.password: { hash, verify }`. No argon2 package needed.
- **`disableSignUp: true` also blocks server-side `auth.api.signUpEmail`** (check is in the endpoint: `EMAIL_PASSWORD_SIGN_UP_DISABLED`). To create invited users programmatically use the admin plugin: `await auth.api.createUser({ body: { email, name, password, role: 'user' } })` - with no headers/session it is allowed server-side (better-auth/dist/plugins/admin/routes.mjs). Does not require email verification; hashes with configured hasher. Alternative: `(await auth.$context).internalAdapter.createUser/linkAccount`.
- twoFactor: server `twoFactor({ issuer, totpOptions, backupCodeOptions, skipVerificationOnEnable })`; adds `user.twoFactorEnabled` + `twoFactor` table. Client: `createAuthClient({ plugins: [twoFactorClient({ onTwoFactorRedirect(){ location.href='/2fa' } })] })`; flow: `authClient.twoFactor.enable({ password })` -> `{ totpURI, backupCodes }` (render QR from totpURI) -> `authClient.twoFactor.verifyTotp({ code })` (enables it) ; login: after signIn returns `twoFactorRedirect`, call `verifyTotp({ code, trustDevice? })` or `verifyBackupCode`; also `disable({password})`, `getTotpUri({password})`, `generateBackupCodes({password})`. Endpoints at `/two-factor/*` (two-factor/client.d.mts).
- organization: `organization({ ac, roles, creatorRole, allowUserToCreateOrganization, invitationExpiresIn, requireEmailVerificationOnInvitation, dynamicAccessControl, sendInvitationEmail: async ({ id, email, role, organization, inviter, invitation }) => {...} })`. Client `organizationClient({ ac, roles })`: `authClient.organization.create({name, slug})`, `.inviteMember({email, role, organizationId})`, `.acceptInvitation({invitationId})` (accepting user must be signed in with matching email -> with disableSignUp you must create the account server-side first). Server equivalents under `auth.api.*`.
```ts
import { createAccessControl } from 'better-auth/plugins/access'
const ac = createAccessControl({ transaction: ['read','create','update','delete'] } as const)
const member = ac.newRole({ transaction: ['read','create'] })
const owner  = ac.newRole({ transaction: ['read','create','update','delete'] })
organization({ ac, roles: { owner, member } })
```
- admin plugin: `admin({ defaultRole, adminRoles, ac, roles, adminUserIds })`; adds `role/banned/banReason/banExpires` on user; `auth.api.createUser/listUsers/setRole/banUser/impersonateUser...`.
- Rate limit: `rateLimit: { enabled, window, max, storage: 'memory'|'database'|'secondary-storage', customRules: { '/sign-in/email': { window: 60, max: 5 } }, customStorage }`; **on only in production by default**. IP header config: `advanced.ipAddress.ipAddressHeaders` (behind proxy set e.g. `['x-forwarded-for']`).
- Next helpers: `nextCookies()` is needed so cookies set by `auth.api.*` calls inside Server Actions work. Session on server: `await auth.api.getSession({ headers: await headers() })`.

### MCP / OAuth provider (BREAKING vs older docs)
- Old `mcp` plugin / `withMcpAuth` / `oidcProvider` in `better-auth/plugins` are gone from 1.7 (not present in dist/plugins). Use `@better-auth/mcp` (built on `@better-auth/oauth-provider`; cannot be combined with a separate `oauthProvider`). Requires `jwt()` plugin (@better-auth/mcp/README.md).
```ts
import { jwt } from 'better-auth/plugins'
import { mcp, requireMcpAuth } from '@better-auth/mcp'
betterAuth({ plugins: [ jwt(), mcp({ loginPage: '/login', consentPage: '/consent', resource: 'https://app.example.com/api/mcp' /* https, no query/fragment */ }) ] })
```
- Client registration is OFF by default (no DCR). Options: `@better-auth/cimd` `cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' })` (Client ID Metadata Documents) or enable oauth-provider dynamic registration options explicitly (check `OAuthOptions` in @better-auth/oauth-provider/dist/index.d.mts). Refresh token reuse window 30s default.
- Protect a route: `requireMcpAuth(auth, (request: Request, claims: JWTPayload) => Response, { requiredScopes?, resource?, issuer?, jwksUrl?, challengeScopes? })` returns `(req: Request) => Promise<Response>`; 401 gets RFC 9728 WWW-Authenticate; 403 insufficient_scope. `createMcpProtectedRequestHandler({issuer, audience, jwksUrl, ...}, handler)` for a separate resource server.
- The plugin serves `/.well-known/oauth-protected-resource` (and `...<resource path>`) via its `onRequest`, i.e. under the auth handler; (UNVERIFIED) whether you must add root-level `app/.well-known/...` route files that forward to `auth.handler` since auth lives under `/api/auth`. Test with curl.

## 3. drizzle-orm 0.45 / drizzle-kit 0.31
```ts
import { pgTable, bigint, text, pgPolicy, pgRole } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
export const appRole = pgRole('app_user').existing()
export const tx = pgTable('tx', {
  id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(), // mode:'number' = JS number (<=2^53); mode:'bigint' = JS bigint
  householdId: bigint('household_id', { mode: 'number' }).notNull(),
}, (t) => [
  pgPolicy('hh_isolation', { as: 'permissive', for: 'all', to: appRole,
    using: sql`${t.householdId} = current_setting('app.household_id')::bigint`,
    withCheck: sql`${t.householdId} = current_setting('app.household_id')::bigint` }),
]).enableRLS()
```
- Table 3rd arg returns an ARRAY (object form deprecated). `pgPolicy` config: `as, for, to, using, withCheck`. `pgRole(name,{createRole,createDb,inherit}).existing()`. drizzle-kit only manages roles if `entities: { roles: true | { provider, exclude, include } }` in config. drizzle-kit does not emit `FORCE ROW LEVEL SECURITY`; the table owner bypasses RLS, so connect the app as a non-owner role (or add FORCE in a custom migration).
- Config: `drizzle.config.ts` `export default defineConfig({ dialect: 'postgresql', schema: './db/schema.ts', out: './drizzle', dbCredentials: { url } })`. CLI: `npx drizzle-kit generate` / `migrate` / `generate --custom`.
- Programmatic migrate: `import { drizzle } from 'drizzle-orm/node-postgres'; import { migrate } from 'drizzle-orm/node-postgres/migrator'; await migrate(db, { migrationsFolder: './drizzle' })` (migrator.d.ts: `migrate(db, config)`).
- Tx-scoped setting: 
```ts
await db.transaction(async (tx) => {
  await tx.execute(sql`select set_config('app.household_id', ${String(householdId)}, true)`) // true = local to tx
  return tx.select().from(txTable)
})
```
- pg: `new Pool({ connectionString })`; `drizzle(pool, { schema })` (also `drizzle({ client: pool, schema })`).

## 4. pg-boss 12.38 (ESM, named export `PgBoss`; no default export)
```ts
import { PgBoss } from 'pg-boss'
const boss = new PgBoss(process.env.DATABASE_URL!)   // or { connectionString, schema, max, schedule, supervise, migrate, createSchema, db }
boss.on('error', console.error)
await boss.start()                                   // creates/migrates schema; start({attempts})
await boss.createQueue('email')                      // required before send()/schedule(); work() alone does not require it; idempotent
await boss.send('email', { to: 'a@b.c' }, { retryLimit: 3 })   // -> id | null
await boss.work<{to:string}>('email', async (jobs) => { for (const j of jobs) {/* j.id, j.data */} }) // handler receives Job[] (array) even w/ batchSize 1; throw => fail
await boss.work('q', { batchSize: 5, includeMetadata: true }, async (jobs) => {})
await boss.schedule('daily-digest', '0 7 * * *', { x: 1 }, { tz: 'UTC', key: 'main' })  // queue must exist; missed: 'skip'|'once'
await boss.unschedule('daily-digest')
await boss.stop({ graceful: true, timeout: 30000, close: true })   // defaults shown
```
- Transactional enqueue with drizzle: `import { fromDrizzle } from 'pg-boss'`; `boss.send(name, data, { db: fromDrizzle(tx, sql) })`. Also `sendAfter`, `sendThrottled`, `sendDebounced`, `insert`, `flow`, `deadLetter` queue option, `{transactional:true}` work option gives `(jobs, tx)`.
- Run in a long-lived process (Next standalone: start in `instrumentation.ts` `register()` guarded by `process.env.NEXT_RUNTIME === 'nodejs'`, or a separate worker process) (pattern, UNVERIFIED against Next docs).

## 5. next-intl 4.14 without i18n routing
```ts
// next.config.ts
import createNextIntlPlugin from 'next-intl/plugin'
export default createNextIntlPlugin()({ output: 'standalone' })   // auto-finds ./i18n/request.ts or ./src/i18n/request.ts, or pass path
// i18n/request.ts
import { getRequestConfig } from 'next-intl/server'
import { cookies } from 'next/headers'
export default getRequestConfig(async () => {
  const locale = (await cookies()).get('locale')?.value ?? 'en'
  return { locale, messages: (await import(`../messages/${locale}.json`)).default }
})
// app/layout.tsx (server)
import { NextIntlClientProvider } from 'next-intl'
import { getLocale } from 'next-intl/server'
<html lang={await getLocale()}><NextIntlClientProvider>{children}</NextIntlClientProvider></html>
```
- No middleware needed. `requestLocale` param of getRequestConfig is deprecated (root-params migration); you don't need it. Provider inherits locale/messages from request config (no props needed). Server: `await getTranslations('ns')`; client: `useTranslations`.

## 6. Serwist with Next 16
- `@serwist/next` 9.5.13 is **webpack-only** (injects `webpack()`); under Turbopack it warns and doesn't work. Options: (a) `next build --webpack` + `next dev --webpack` with `withSerwistInit({ swSrc:'app/sw.ts', swDest:'public/sw.js', disable: dev })`; (b) **`@serwist/turbopack`** (experimental): route handler builds SW with esbuild; (c) "configurator mode" (`@serwist/next/config` + `@serwist/cli`, post-build step; exports `serwist.withNextConfig`).
- Turbopack mode API from d.ts (@serwist/turbopack/dist/index.d.mts, index.react.d.mts); usage pattern (UNVERIFIED, docs unreachable):
```ts
// app/serwist/[path]/route.ts
import { createSerwistRoute } from '@serwist/turbopack'
export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } =
  createSerwistRoute({ swSrc: 'app/sw.ts', useNativeEsbuild: true })
// next.config.ts: import { withSerwist } from '@serwist/turbopack'; export default withSerwist({...})
// client: import { SerwistProvider } from '@serwist/turbopack/react'
<SerwistProvider swUrl="/serwist/sw.js">{children}</SerwistProvider>
```
- SW source (both modes): `import { defaultCache } from '@serwist/next/worker'; import { Serwist } from 'serwist'; new Serwist({ precacheEntries: self.__SW_MANIFEST, skipWaiting: true, clientsClaim: true, navigationPreload: true, runtimeCaching: defaultCache }).addEventListeners()`.
- Push: web-push `webpush.setVapidDetails('mailto:..', pub, priv); await webpush.sendNotification(sub, JSON.stringify(payload))`; `generateVAPIDKeys()`; SW handles `push` / `notificationclick`.

## 7. Tailwind 4.3 / shadcn
- `postcss.config.mjs`: `export default { plugins: { '@tailwindcss/postcss': {} } }`. No `tailwind.config.js` needed. CSS: `@import "tailwindcss";` then `@theme { --color-brand: oklch(0.6 0.2 250); --font-sans: ...; }`. Content auto-detected.
- shadcn 4.22: `npx shadcn@latest init` (flags: `-t next`, `-b base|radix|aria`, `-p <preset>`, `-d` defaults = next + preset `base-nova`, `-y`, `--css-variables`). Note the new `--base` choice: the default may pick Base UI rather than Radix; pass `-b radix` if you want Radix. Components: `npx shadcn@latest add button`. Tailwind v4 / React 19 supported (CLI help).

## 8. MCP TypeScript SDK **v2** (`@modelcontextprotocol/server` 2.3.1)
Verified by running a tools/list request against a handler (HTTP 200, SSE-framed result).
```ts
// app/api/mcp/route.ts
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { requireMcpAuth } from '@better-auth/mcp'
import * as z from 'zod/v4'
const handler = createMcpHandler((ctx) => {         // factory runs once per request (stateless); ctx: { era, authInfo, requestInfo }
  const s = new McpServer({ name: 'arfolio', version: '1.0.0' })
  s.registerTool('add-note', { description: 'Save a note', inputSchema: z.object({ text: z.string() }) },
    async ({ text }, c) => ({ content: [{ type: 'text', text }] }))   // c.http.authInfo available
  return s
}, { legacy: 'stateless' /* default; 'reject' = 2026-only */, responseMode: 'auto' | 'json' | 'sse' })
export const POST = requireMcpAuth(auth, (req, claims) =>
  handler.fetch(req, { authInfo: { token: '', clientId: String(claims.azp ?? ''), scopes: String(claims.scope ?? '').split(' '), extra: { userId: claims.sub } } }))
```
- `handler.fetch(Request, { authInfo, parsedBody })` returns web `Response`; the handler never verifies tokens. GET/DELETE return 405 in stateless legacy mode. Export only POST. `toNodeHandler` from `@modelcontextprotocol/node` is only for Node req/res. `registerTool` is the API (`tool()` is v1). inputSchema takes any Standard Schema (zod 3.25+/4, valibot, arktype) - an object schema, not a raw shape. AuthInfo field names (UNVERIFIED exact type; check `AuthInfo` in server d.ts).
- v1 `@modelcontextprotocol/sdk` 1.32.1 (`StreamableHTTPServerTransport`, `McpServer.tool`) still exists; README of v2 says v2 "replaces" it. tsconfig with TS>=6: add `"types": ["node"]`.

## 9. Anthropic SDK 0.135
```ts
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import * as z from 'zod'
const client = new Anthropic()   // ANTHROPIC_API_KEY
const msg = await client.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 1024, messages: [{ role: 'user', content: 'Hi' }] })
// msg.content[0].type === 'text' ? msg.content[0].text
// Structured JSON (GA field output_config.format, not tool trick):
const r = await client.messages.parse({ model: 'claude-sonnet-5-5', max_tokens: 1024,
  messages: [{ role: 'user', content: '...' }],
  output_config: { format: zodOutputFormat(z.object({ category: z.string(), amount: z.number() })) } })
r.parsed_output?.category
```
- Model ids in `Model` union (resources/messages/messages.d.ts): `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`, `claude-mythos-5-1`, plus aliases `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-8/4-7/4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`. Tool use still via `tools: [{ name, description, input_schema }]` + `tool_choice`. `max_tokens` required. `client.messages.stream()` also parses.

## 10. vitest 5 / zod 4 / misc
- vitest 5: install `vite` and `@types/node`; node >=22.12. `vitest.config.ts` `defineConfig` from `vitest/config`. 
- zod 4: `import * as z from 'zod'` (v4); `z.email()`, `z.url()` top-level validators; error customization via `{ error: '...' }` (not `message`).
- `serverExternalPackages` in Next may be needed for native/ESM-only server deps (pg-boss, pg); (UNVERIFIED necessity).
