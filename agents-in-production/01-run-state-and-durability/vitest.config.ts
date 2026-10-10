import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './test/setup.ts',
    fileParallelism: false, // the tests share one database and one payments service
    testTimeout: 30_000,
  },
});
