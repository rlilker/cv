import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests for the Family Assistant dashboard.
 *
 * These exist because the bugs that actually reached production were not
 * detectable by reading the source or by a regex over it:
 *
 *   - the Google button never rendered, because a module-level TypeError killed
 *     the script;
 *   - the service worker could not register, because a file using `import` was
 *     registered as a classic worker;
 *   - the settings fields were not editable, because readOnly was set once and
 *     never cleared.
 *
 * All three passed the unit tests. Only a browser catches them, so this suite
 * runs the real production build in Chromium rather than a component in
 * isolation.
 *
 * The Firebase SDK is intercepted (see tests/fixtures/firebase-stub.js) so the
 * suite needs no project, no credentials and no network.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: 'http://127.0.0.1:4321',
    trace: 'retain-on-failure',
    // The push tests need a secure context; 127.0.0.1 counts as one, so no
    // HTTPS server and no ignored-certificate warning is needed here.
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
    {
      // Every mobile-layout bug was reported from a 360-390px phone, so the
      // mobile project is where the overflow regressions are actually pinned.
      name: 'mobile-chromium',
      use: { ...devices['Pixel 5'] },
    },
  ],
  webServer: {
    // Build with placeholder Firebase values first. Without them the page
    // renders "Not configured yet" and never boots, so the tests would pass by
    // exercising an early-return page rather than the real one.
    command: 'npm run build:e2e && node tests/e2e/serve.mjs',
    url: 'http://127.0.0.1:4321/family-assistant/dashboard',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});