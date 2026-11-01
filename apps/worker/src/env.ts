import { integrationEnvShape, parseEnv, refineIntegrationEnv } from '@arfolio/core';
import { z } from 'zod';

const schema = z
  .object({
    /** Connection string for the unprivileged `pfm_app` role. */
    DATABASE_URL: z.string().min(1),
    WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(8081),
    TZ: z.string().min(1).default('UTC'),
    /** Public URL of the app (as in the web Deployment): the default VAPID subject when https. */
    APP_URL: z.preprocess((v) => (v === '' ? undefined : v), z.url().optional()),
    ...integrationEnvShape,
  })
  .superRefine(refineIntegrationEnv);

export type WorkerEnv = z.infer<typeof schema>;

/** Throws an EnvError naming the offending keys (never their values) when the env is invalid. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return parseEnv(schema, source);
}
