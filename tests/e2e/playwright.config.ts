import { defineConfig } from '@playwright/test';

/**
 * The real UI (static export, as Tauri serves it) against the real compiled backend, with the
 * offline fake coding agent: no AI calls, no network. Run with `pnpm e2e` from the root.
 *
 * Browser: Microsoft Edge by default, which ships with Windows and needs no download. Set
 * E2E_BROWSER=chromium (after `pnpm exec playwright install chromium`) elsewhere, e.g. CI.
 */
const browser = process.env.E2E_BROWSER ?? 'msedge';

export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.ts',
  // Every test starts its own backend on fixed ports, so tests run one at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    ...(browser === 'chromium' ? {} : { channel: browser }),
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
