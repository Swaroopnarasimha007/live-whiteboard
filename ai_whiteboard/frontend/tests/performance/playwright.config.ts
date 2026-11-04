import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  workers: 1,
  timeout: 120000,
  use: {
    baseURL: 'http://127.0.0.1:4183',
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: 'npm run dev -- --port 4183 --strictPort',
    cwd: '../..',
    url: 'http://127.0.0.1:4183',
    reuseExistingServer: !process.env.CI,
  },
});
