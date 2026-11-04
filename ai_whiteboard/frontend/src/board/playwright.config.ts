import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.browser.spec.ts',
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:4176',
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
    hasTouch: true,
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: 'npm run dev -- --port 4176 --strictPort',
    cwd: '../..',
    url: 'http://127.0.0.1:4176',
    reuseExistingServer: !process.env.CI,
  },
});
