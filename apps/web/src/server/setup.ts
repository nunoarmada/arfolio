import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, withHousehold, type Db } from '@arfolio/db';
import { resolveTemplateLocale, seedCategoryTemplates } from '@arfolio/services';
import { getAuth, type Auth } from '../lib/auth';
import { nameSchema, passwordSchema } from '../lib/credentials';
import { getDb } from '../lib/db';
import { getEnv } from '../lib/env';
import { withUserCreation } from '../lib/user-creation';

export class SetupClosedError extends Error {
  constructor() {
    super('Setup is already complete');
    this.name = 'SetupClosedError';
  }
}

export class InvalidSetupTokenError extends Error {
  constructor() {
    super('Invalid setup token');
    this.name = 'InvalidSetupTokenError';
  }
}

export interface SetupDeps {
  db: Db;
  auth: Auth;
  env: { SETUP_TOKEN: string };
}

const setupInputSchema = z.object({
  token: z.string(),
  name: nameSchema,
  email: z.email(),
  password: passwordSchema,
  householdName: nameSchema,
  locale: z.string().min(2).max(35),
  // Optional household settings, inserted together with the row (defaults apply when omitted).
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  timezone: z.string().min(1).max(64).optional(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
});

export type SetupInput = z.input<typeof setupInputSchema>;

function defaultDeps(): SetupDeps {
  return { db: getDb(), auth: getAuth(), env: getEnv() };
}

async function userCount(db: Db): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.user);
  return row?.n ?? 0;
}

/** Setup is open only while no account exists. */
export async function isSetupOpen(db: Db = getDb()): Promise<boolean> {
  return (await userCount(db)) === 0;
}

function tokensMatch(given: string, expected: string): boolean {
  // Hash first so the comparison is constant-time regardless of length.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** True when `given` is the installation's setup token (constant-time). Never throws. */
export function isValidSetupToken(
  given: unknown,
  env: { SETUP_TOKEN: string } = getEnv(),
): boolean {
  return typeof given === 'string' && tokensMatch(given, env.SETUP_TOKEN);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'household'}-${randomBytes(3).toString('hex')}`;
}

/**
 * Creates the first owner, their household (Better Auth organisation), its settings and the
 * default category templates (in the household locale).
 * If any step after the user is created fails, everything created so far is removed so setup
 * stays open for a retry.
 */
export async function completeSetup(
  rawInput: SetupInput,
  deps: SetupDeps = defaultDeps(),
): Promise<{ userId: string; householdId: string }> {
  const { db, auth, env } = deps;
  // Only the token's shape is validated before it is checked, so callers learn nothing about the
  // other fields without a valid token; the full input is validated right after.
  const token = z.string().safeParse((rawInput as { token?: unknown } | null)?.token);
  if (!token.success || !tokensMatch(token.data, env.SETUP_TOKEN)) {
    throw new InvalidSetupTokenError();
  }
  if (!(await isSetupOpen(db))) throw new SetupClosedError();
  const input = setupInputSchema.parse(rawInput);

  const { user } = await withUserCreation({ kind: 'setup' }, () =>
    auth.api.createUser({
      body: { email: input.email, name: input.name, password: input.password },
    }),
  );

  let householdId: string | undefined;
  try {
    // Two concurrent setups can both pass the open check above; only one may keep its account.
    if ((await userCount(db)) > 1) throw new SetupClosedError();

    const org = await auth.api.createOrganization({
      body: { name: input.householdName, slug: slugify(input.householdName), userId: user.id },
    });
    householdId = org.id;
    await withHousehold(db, org.id, (tx) =>
      tx.insert(schema.householdSettings).values({
        householdId: org.id,
        locale: input.locale,
        ...(input.currency ? { currency: input.currency } : {}),
        ...(input.timezone ? { timezone: input.timezone } : {}),
        ...(input.fiscalYearStartMonth ? { fiscalYearStartMonth: input.fiscalYearStartMonth } : {}),
      }),
    );
    // Inside the try: a failure here removes the household and user like any other setup step.
    await seedCategoryTemplates(
      { db, householdId: org.id, userId: user.id, role: 'owner' },
      resolveTemplateLocale(input.locale),
    );
    return { userId: user.id, householdId: org.id };
  } catch (error) {
    // Deleting the organisation cascades to members and settings; the user cascades to the rest.
    // A failing cleanup is logged (message only) and must never replace the original error.
    try {
      if (householdId) {
        await db.delete(schema.organization).where(eq(schema.organization.id, householdId));
      }
    } catch (cleanupError) {
      console.error(`setup cleanup failed (organization): ${describe(cleanupError)}`);
    }
    try {
      await db.delete(schema.user).where(eq(schema.user.id, user.id));
    } catch (cleanupError) {
      console.error(`setup cleanup failed (user): ${describe(cleanupError)}`);
    }
    throw error;
  }
}
