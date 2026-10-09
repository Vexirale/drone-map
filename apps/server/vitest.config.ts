import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'server',
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'],
    // The integration tests share one test database.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
