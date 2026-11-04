import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';

test('real HTTP operations reach actual Konva draws before terminal, with separate browser clock spans', async ({
  page,
  browser,
}, testInfo) => {
  await page.goto('/');
  const result = await page.evaluate(async () =>
    (await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'drawHarness.ts')).measureDraws(),
  );
  const report = {
    measuredAt: new Date().toISOString(),
    browser: browser.version(),
    headless: true,
    machine: {
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      memoryGiB: os.totalmem() / 1024 ** 3,
      os: `${os.platform()} ${os.release()} ${os.arch()}`,
    },
    ...result,
  };
  await writeFile(testInfo.outputPath('draw-benchmark.json'), JSON.stringify(report, null, 2));
  await testInfo.attach('draw-benchmark', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  expect(result.completeOperationToKonvaDrawMs.samples).toBe(30);
  expect(result.beforeTerminal).toBe(true);
  expect(result.pending).toBe(0);
  if (process.env.WHITEBOARD_PERFORMANCE_GATE === '1')
    expect(result.completeOperationToKonvaDrawMs.p95).toBeLessThan(50);
});
