import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const backend = path.resolve(root, '../backed/backend');
const python = path.join(
  backend,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
export default defineConfig({
  testDir: '.',
  testMatch: '*.browser.spec.ts',
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:4186',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
  webServer: [
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 4186 --strictPort',
      cwd: root,
      url: 'http://127.0.0.1:4186',
      reuseExistingServer: false,
    },
    {
      command: `"${python}" -m app`,
      cwd: backend,
      url: 'http://127.0.0.1:8013/health/ready',
      reuseExistingServer: false,
      env: {
        WHITEBOARD__SERVER__PORT: '8013',
        WHITEBOARD__SERVER__ALLOWED_ORIGINS: '[http://127.0.0.1:4186]',
        WHITEBOARD__DIAGRAM__PROFILES__MOCK__MODEL: 'delayed',
        WHITEBOARD__TRANSCRIPTION__DEFAULT_PROFILE: 'mock',
        WHITEBOARD__DIAGRAM__ACTIVE_PROFILE: 'mock',
      },
    },
  ],
});
