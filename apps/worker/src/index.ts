import type { PgBoss } from 'pg-boss';
import { EnvError } from '@arfolio/core';
import { loadEncryptionKey } from '@arfolio/core/server';
import { createDb, schema } from '@arfolio/db';
import {
  createIntegrationConfigCache,
  createWebPushSender,
  resolveIntegrationConfig,
} from '@arfolio/services';
import { afterSyncAll } from './after-sync.js';
import { startBoss } from './boss.js';
import { createWorkerConnectors } from './connectors.js';
import { loadEnv } from './env.js';
import { createHealthServer } from './health.js';
import { createAnthropicMemo, registerAiCategorise } from './jobs/ai-categorise.js';
import { registerAiReport } from './jobs/ai-report.js';
import {
  ASSET_VALUATION_REQUEST_TIMEOUT_MS,
  registerAssetValuation,
} from './jobs/asset-valuation.js';
import { registerMerchantEnrich } from './jobs/merchant-enrich.js';
import { registerBudgetAlerts } from './jobs/budget-alerts.js';
import { registerConsentCheck } from './jobs/consent-check.js';
import { registerHeartbeat } from './jobs/heartbeat.js';
import { registerNetWorthSnapshot } from './jobs/net-worth-snapshot.js';
import { queuePushDelivery, registerPushDeliver } from './jobs/push-deliver.js';
import { registerPruneSyncData } from './jobs/prune-sync-data.js';
import { registerRecurringDetect } from './jobs/recurring-detect.js';
import { registerT212Export } from './jobs/t212-export.js';
import { registerSyncConnection } from './jobs/sync-connection.js';
import { registerSyncScheduler } from './jobs/sync-scheduler.js';
import { errorMessage, log } from './log.js';
import { runStartupBackfill, runStartupTransferRepair } from './startup.js';

const STOP_TIMEOUT_MS = 25_000;
const HEALTH_DB_TIMEOUT_MS = 2_000;
/** How long a resolved integration config is reused before the database is read again. */
const INTEGRATION_CONFIG_TTL_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv();
  } catch (err) {
    log.error(err instanceof EnvError ? err.message : 'invalid environment');
    process.exit(1);
  }
  process.env.TZ = env.TZ;

  const onError = (message: string): void => log.error(`database pool error: ${message}`);
  const { db, pool } = createDb(env.DATABASE_URL, { max: 4, onError });
  // Dedicated single-connection pool so a hung probe is cancelled server-side and never starves jobs.
  const probe = createDb(env.DATABASE_URL, {
    max: 1,
    statementTimeoutMs: HEALTH_DB_TIMEOUT_MS,
    onError,
  });
  let boss: PgBoss | undefined;
  let stopping = false;

  const health = createHealthServer(async () => {
    if (!boss || stopping) return false;
    try {
      await withTimeout(probe.db.select().from(schema.systemStatus).limit(1), HEALTH_DB_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  });

  let shutdown: Promise<void> | undefined;
  const stop = (signal: string, failed = false): Promise<void> => {
    shutdown ??= (async () => {
      stopping = true;
      log.info(`${signal} received, shutting down`);
      let code = failed ? 1 : 0;
      try {
        // A start still in flight must settle first so its boss instance is not leaked.
        await starting.catch(() => {});
        if (health.listening) await new Promise<void>((resolve) => health.close(() => resolve()));
        await boss?.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
        await Promise.all([pool.end(), probe.pool.end()]);
      } catch (err) {
        log.error(`shutdown failed: ${errorMessage(err)}`);
        code = 1;
      }
      process.exit(code);
    })();
    return shutdown;
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));

  const starting = (async () => {
    boss = await startBoss(env.DATABASE_URL);
    if (stopping) return; // a signal arrived during start; stop() will stop this boss
    await registerHeartbeat(boss, db, env.TZ);
    const encryptionKey = loadEncryptionKey(env.ENCRYPTION_KEY);
    const enqueuePush = await registerPushDeliver(
      boss,
      {
        db,
        encryptionKey,
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
        subject: env.VAPID_SUBJECT,
        appUrl: env.APP_URL,
        allowedHosts: env.PUSH_ALLOWED_HOSTS,
        sender: createWebPushSender(),
      },
      env.TZ,
    );
    // Jobs that create notifications ask for a prompt delivery when they finish.
    const afterNotify = () => queuePushDelivery(enqueuePush);
    // Integration settings (key, models, portals, bank credentials) are read at each run through
    // this short cache, so a change saved in the app applies within a minute without a restart.
    // The raw environment is passed: a set env variable still wins over a stored value.
    const { get: getConfig } = createIntegrationConfigCache(
      () => resolveIntegrationConfig(db, encryptionKey, process.env),
      INTEGRATION_CONFIG_TTL_MS,
    );
    const aiDeps = { db, getConfig };
    const anthropic = createAnthropicMemo();
    const afterCategorise = await registerAiCategorise(
      boss,
      { ...aiDeps, getAnthropic: anthropic },
      env.TZ,
    );
    const afterMerchants = await registerMerchantEnrich(
      boss,
      { ...aiDeps, getAnthropic: anthropic, logos: env.MERCHANT_LOGOS === 'on' },
      env.TZ,
    );
    // After a sync: categorise and name the merchants (both are queued, not run inline).
    const afterSync = afterSyncAll(
      [
        ['categorise', afterCategorise],
        ['merchants', afterMerchants],
      ],
      log,
    );
    // The sweep owns retries and backoff for reports: the SDK must not retry inside a request.
    await registerAiReport(
      boss,
      { ...aiDeps, getAnthropic: createAnthropicMemo({ maxRetries: 0 }) },
      env.TZ,
      afterNotify,
    );
    // Valuations: no SDK retries (the sweep retries an api_error after 12 hours) and a long
    // timeout, since one turn may search and fetch several pages.
    await registerAssetValuation(
      boss,
      {
        ...aiDeps,
        getAnthropic: createAnthropicMemo({
          maxRetries: 0,
          timeout: ASSET_VALUATION_REQUEST_TIMEOUT_MS,
        }),
      },
      env.TZ,
    );
    const connectorsFor = createWorkerConnectors({
      encryptionKey,
      ...(env.TRADING212_API_URL ? { trading212ApiUrl: env.TRADING212_API_URL } : {}),
    });
    const getConnectors = async () => connectorsFor(await getConfig());
    const enqueueT212Export = await registerT212Export(boss, db, getConnectors, afterSync);
    await registerSyncConnection(
      boss,
      db,
      getConnectors,
      afterSync,
      afterNotify,
      enqueueT212Export,
    );
    await registerSyncScheduler(boss, db, env.TZ);
    await registerConsentCheck(boss, db, env.TZ, afterNotify);
    await registerPruneSyncData(boss, db, env.TZ);
    await registerRecurringDetect(boss, db, env.TZ, afterNotify);
    await registerBudgetAlerts(boss, db, env.TZ, afterNotify);
    await registerNetWorthSnapshot(boss, db, env.TZ);
    if (stopping) return;
    await new Promise<void>((resolve, reject) => {
      health.once('error', reject);
      health.listen(env.WORKER_HEALTH_PORT, resolve);
    });
    log.info(`worker started, health on :${env.WORKER_HEALTH_PORT}`);
    // After the health server is up, so a slow backfill never delays readiness; it logs its own failure.
    await runStartupBackfill(db);
    await runStartupTransferRepair(db);
  })();
  starting.catch((err: unknown) => {
    log.error(`startup failed: ${errorMessage(err)}`);
    void stop('startup-failure', true);
  });
}

void main();
