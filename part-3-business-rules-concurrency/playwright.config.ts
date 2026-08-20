import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5103',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chrome',
      use: { channel: 'chrome', headless: false },
    },
  ],
  outputDir: '/tmp/auction-bidding-war-playwright',
  webServer: {
    command: 'npm start',
    url: 'http://localhost:5103/api/health',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
