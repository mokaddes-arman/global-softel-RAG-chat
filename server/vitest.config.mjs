import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.js'],
    setupFiles: ['./tests/setup-env.js'],
    // Each test file gets its own embedded database + storage directory, and
    // files run sequentially so the file-based embedded Postgres is never
    // opened by two processes at once.
    fileParallelism: false,
    isolate: true,
    testTimeout: 120000,
    hookTimeout: 120000,
    reporters: ['default'],
  },
});
