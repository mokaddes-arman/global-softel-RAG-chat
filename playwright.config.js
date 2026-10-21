'use strict';

const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT || 3101);
const baseURL = `http://127.0.0.1:${PORT}`;

/**
 * End-to-end configuration.
 *
 * A single backend is started on its own port (3101) with a throwaway embedded
 * database, deterministic `hash` embeddings and the `mock` language model, and
 * it serves the built SPA. Tests therefore exercise the real upload -> retrieve
 * -> answer -> cite pipeline with no network access and no shared state with a
 * running `npm run dev` instance.
 */
module.exports = defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node e2e/start-server.js',
    cwd: __dirname,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { E2E_PORT: String(PORT) },
  },
});
