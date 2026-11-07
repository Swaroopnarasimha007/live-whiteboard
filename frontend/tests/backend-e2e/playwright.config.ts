import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const backend = path.resolve(root, '../backend');
const python = path.join(
  backend,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
export default defineConfig({
  testDir: '.',
  testMatch: '*.browser.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:4194',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
  webServer: [
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 4194 --strictPort',
      cwd: root,
      url: 'http://127.0.0.1:4194',
      reuseExistingServer: false,
    },
    {
      command: `"${python}" -m tests.integration.fixture_server`,
      cwd: backend,
      url: 'http://127.0.0.1:8024/health/ready',
      reuseExistingServer: false,
    },
  ],
});
