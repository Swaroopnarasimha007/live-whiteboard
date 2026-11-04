import { defineConfig, devices } from '@playwright/test';

// Agent-owned integration test for real IndexedDB, without adding production dependencies.
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.browser.spec.ts',
  use: { baseURL: 'http://127.0.0.1:4174' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -- --port 4174 --strictPort',
    cwd: '../..',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: !process.env.CI,
  },
});
