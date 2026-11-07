import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.browser.spec.ts',
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:4182',
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: 'npm run dev -- --port 4182 --strictPort',
    cwd: '../..',
    url: 'http://127.0.0.1:4182',
    reuseExistingServer: !process.env.CI,
  },
});
