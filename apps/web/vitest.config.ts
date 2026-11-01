import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// next.config.ts inlines the same value into the app at build time.
const rootVersion = (
  JSON.parse(readFileSync(src('../../package.json'), 'utf8')) as { version: string }
).version;

export default defineProject({
  resolve: {
    alias: {
      '@/': src('./src/'),
      // Resolve the workspace DB package to its source so tests do not need a prior build.
      '@arfolio/db': src('../../packages/db/src/index.ts'),
    },
  },
  test: {
    name: 'web',
    env: { NEXT_PUBLIC_APP_VERSION: rootVersion },
    environment: 'node',
    // Playwright specs run through `pnpm e2e`, not vitest.
    exclude: ['e2e/**/*.spec.ts', '**/node_modules/**'],
    globalSetup: ['../../packages/db/test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // The throwaway cluster's pfm_app role is shared by all test databases: run files serially.
    fileParallelism: false,
  },
});
