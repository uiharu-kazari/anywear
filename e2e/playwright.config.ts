import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  outputDir: '.results',
  fullyParallel: true,
  // Traces of these tests hold MBs of image data; keep the machine responsive.
  workers: 4,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  globalSetup: './support/global-setup.ts',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 840 },
    trace: 'on-first-retry',
  },
});
