/**
 * Fills an existing Arfolio household with a deterministic, fictional demo dataset.
 *
 *   pnpm demo:seed [--household <id>] [--months 12] [--locale en|pt-PT] [--seed <n>] [--force]
 *
 * Connects with DATABASE_URL (the app role). Create the household first through the normal
 * /setup flow. Without --household the only household of the instance is used.
 */
import { parseArgs } from 'node:util';
import { createDb, schema, withHousehold } from '../packages/db/src/index.ts';
import {
  DEFAULT_DEMO_SEED,
  DemoSeedError,
  seedDemoHousehold,
} from '../packages/services/src/demo/seed.ts';

const USAGE = `Usage: pnpm demo:seed [options]

  --household <id>   Household (organisation) id; default: the only household
  --months <n>       Months of history before the current month (default 12)
  --locale <l>       en or pt-PT (default: the household's language)
  --seed <n>         PRNG seed (default ${DEFAULT_DEMO_SEED}); the same seed builds the same data
  --force            Seed even if the household already has transactions
  -h, --help         Show this help

Reads DATABASE_URL (the pfm_app role is enough).`;

function fail(message: string): never {
  console.error(`demo:seed: ${message}`);
  process.exit(1);
}

function integerOption(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) fail(`--${name} must be a whole number, got "${raw}"`);
  return Number(raw);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      household: { type: 'string' },
      months: { type: 'string' },
      locale: { type: 'string' },
      seed: { type: 'string' },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    // The package manager may forward a literal `--`.
    allowPositionals: true,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) fail('DATABASE_URL is not set');
  const locale = values.locale;
  if (locale !== undefined && locale !== 'en' && locale !== 'pt-PT') {
    fail(`--locale must be "en" or "pt-PT", got "${locale}"`);
  }
  const months = integerOption('months', values.months, 12);
  const seed = integerOption('seed', values.seed, DEFAULT_DEMO_SEED);

  const { db, pool } = createDb(url, { max: 2 });
  try {
    let householdId = values.household;
    if (!householdId) {
      const households = await db.select({ id: schema.organization.id }).from(schema.organization);
      if (households.length !== 1) {
        fail(
          households.length === 0
            ? 'no household found: create one through /setup first'
            : `${households.length} households found: pass --household <id>`,
        );
      }
      householdId = households[0]!.id;
    }
    const resolvedId = householdId;
    // Row-level security scopes this read to the household, so it needs no filter.
    const [settings] = await withHousehold(db, resolvedId, (tx) =>
      tx.select({ locale: schema.householdSettings.locale }).from(schema.householdSettings),
    );
    if (!settings) fail(`household ${resolvedId} not found (or it has no settings)`);

    const seedLocale = locale ?? (settings.locale.toLowerCase() === 'pt-pt' ? 'pt-PT' : 'en');
    await seedDemoHousehold(db, {
      householdId: resolvedId,
      months,
      locale: seedLocale,
      seed,
      force: values.force,
    });
    console.log(
      `demo:seed: seeded household ${resolvedId} (${months} months, ${seedLocale}, seed ${seed})`,
    );
  } catch (err) {
    if (err instanceof DemoSeedError) fail(err.message);
    throw err;
  } finally {
    await pool.end();
  }
}

await main();
