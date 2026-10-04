import { defineConfig, devices } from '@playwright/test';
import { TARGET, targetConfig } from './target.mjs';

const target = targetConfig();

export default defineConfig({
  testDir: './tests',
  timeout: 360_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  outputDir: 'test-results',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: target.baseURL,
    viewport: { width: 1440, height: 900 },
    locale: 'id-ID',
    colorScheme: 'dark',
    // Traces record request headers; off on remote targets so the Access service token never lands in an artifact.
    trace: TARGET === 'local' ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'journey', testMatch: /journey\.spec\.js/ },
    // api runs before screens: screens (1440) deletes journey's cloned voice, which the api spec uses on staging.
    { name: 'api', testMatch: /api\.spec\.js/, dependencies: ['journey'] },
    { name: 'screens', testMatch: /screens\.spec\.js/, dependencies: ['journey', 'api'] },
    { name: 'smoke', testMatch: /smoke\.spec\.js/ },
  ],
  webServer: target.webServer,
});
