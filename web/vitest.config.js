import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.js'],
    setupFiles: ['server/test/setup-env.js'],
    testTimeout: 20000,
    hookTimeout: 20000,
    maxWorkers: 4,
  },
});
