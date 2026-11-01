import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: {
      // Resolve the workspace DB package to its source so tests do not need a prior build.
      '@arfolio/db': fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'worker',
    environment: 'node',
    globalSetup: ['../../packages/db/test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // The throwaway cluster's pfm_app role is shared by all test databases: run files serially.
    fileParallelism: false,
  },
});
