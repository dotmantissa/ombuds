import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', fullyParallel: false, workers: 1, timeout: 90_000,
  expect: { timeout: 15_000 }, reporter: 'list', use: { baseURL: 'http://127.0.0.1:3100', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'node ../scripts/test_localnet.mjs --serve', url: 'http://127.0.0.1:3100/account',
    reuseExistingServer: false, timeout: 240_000 },
});
