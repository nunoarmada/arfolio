import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'db',
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // pfm_app is a cluster-wide role shared by every test database, so files run one at a time.
    fileParallelism: false,
  },
});
