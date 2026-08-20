import { defineConfig } from '@playwright/test';

const distributedRealtime = process.env.DISTRIBUTED_REALTIME === '1';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5105',
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
    command: distributedRealtime ? 'npm run start:distributed' : 'npm start',
    url: 'http://localhost:5105/api/health',
    reuseExistingServer: !distributedRealtime,
    timeout: 120_000,
  },
});
