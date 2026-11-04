import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.browser.spec.ts',
  // Backend bridge tests start their own HTTP/WS server through backend/playwright.config.ts.
  testIgnore: '**/backend/**',
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:4181',
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    permissions: ['microphone'],
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: 'npm run dev -- --port 4181 --strictPort',
    cwd: '../..',
    url: 'http://127.0.0.1:4181',
    reuseExistingServer: !process.env.CI,
  },
});
