import { defineConfig } from '@playwright/test';
import { E2E } from './tests/e2e/ports.mjs';

/* Smoke run of the real UI against a throwaway backend and a fake model server (tests/e2e/servers.mjs).
   Uses the Edge already installed on Windows, so Playwright never downloads a browser. */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: {
    channel: 'msedge',
    baseURL: `http://localhost:${E2E.ui}/?backend=${E2E.backend}&token=${E2E.token}`,
    viewport: { width: 1400, height: 900 },
  },
  webServer: [
    { command: 'node tests/e2e/servers.mjs', url: `http://127.0.0.1:${E2E.backend}/health`, timeout: 60_000, reuseExistingServer: false },
    { command: `npx vite --port ${E2E.ui} --strictPort`, url: `http://localhost:${E2E.ui}`, timeout: 60_000, reuseExistingServer: false },
  ],
});
