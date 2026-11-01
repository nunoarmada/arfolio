import { PgBoss, type Job, type Queue, type WorkOptions } from 'pg-boss';
import { errorMessage, log } from './log.js';

/**
 * Starts pg-boss as the unprivileged `pfm_app` role. The `pgboss` schema is installed by
 * `runMigrations` (as the owner), so this never runs DDL: no migrations, no schema creation.
 */
export async function startBoss(url: string): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: url,
    schema: 'pgboss',
    migrate: false,
    createSchema: false,
  });
  boss.on('error', (err) => log.error(`pg-boss error: ${errorMessage(err)}`));
  await boss.start();
  return boss;
}

/**
 * Creates the queue (idempotent) and runs `handler` once per job. Jobs are fetched one at a time
 * (`batchSize: 1`), so a throw fails exactly that job and pg-boss applies its retry policy to it.
 */
export async function registerJob<T extends object>(
  boss: PgBoss,
  name: string,
  handler: (job: Job<T>) => Promise<void>,
  opts: WorkOptions = {},
  queueOptions?: Omit<Queue, 'name'>,
): Promise<void> {
  await boss.createQueue(name, queueOptions);
  await boss.work<T>(name, { ...opts, batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await handler(job);
  });
}
