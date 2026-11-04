import { spawnSync } from 'node:child_process';
import process from 'node:process';
const result = spawnSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', '--config', 'tests/backend-e2e/vitest.config.ts'],
  { stdio: 'inherit', env: { ...process.env, WHITEBOARD_REQUIRE_PROTOCOL: '1' } },
);
process.exit(result.status ?? 1);
