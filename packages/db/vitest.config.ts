import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Schema tests share one database; running files in parallel would let one
    // test's rollback race another's fixtures.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ['test/**/*.test.ts'],
  },
});
