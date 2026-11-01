// Config entry for the Better Auth CLI (`pnpm --filter @arfolio/web auth:generate`). The CLI only
// reads the option/plugin shape to derive the schema, so a stub db and dummy env are enough.
import type { Db } from '@arfolio/db';
import { createAuth } from './auth';

export const auth = createAuth({
  db: {} as Db,
  env: {
    BETTER_AUTH_SECRET: 'cli-only-secret-cli-only-secret-cli-only',
    BETTER_AUTH_URL: 'http://localhost:3000',
    APP_URL: 'http://localhost:3000',
    BRAND_NAME: 'Arfolio',
  },
});
