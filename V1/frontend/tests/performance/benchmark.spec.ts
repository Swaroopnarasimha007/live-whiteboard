import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
test('controlled stream, actual Konva draws and long-session navigation benchmark', async ({
  page,
  context,
  browser,
}, testInfo) => {
  await page.goto('/tests/harness.html');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,blink.user_timing',
    transferMode: 'ReturnAsStream',
  });
  const result = await page.evaluate(async () =>
    (await import(/* @vite-ignore */ '/tests/performance/' + 'harness.ts')).runBenchmark(),
  );
  const complete = new Promise<{ stream: string }>((resolve) =>
    cdp.once('Tracing.tracingComplete', (event) => resolve({ stream: event.stream! })),
  );
  await cdp.send('Tracing.end');
  const trace = await complete;
  let content = '';
  while (true) {
    const part = await cdp.send('IO.read', { handle: trace.stream });
    content += part.data;
    if (part.eof) break;
  }
  await cdp.send('IO.close', { handle: trace.stream });
  const events = (JSON.parse(content) as { traceEvents: { name: string }[] }).traceEvents;
  const paints = events.filter((e) => e.name === 'Paint').length;
  const report = {
    measuredAt: new Date().toISOString(),
    machine: {
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      memoryGiB: os.totalmem() / 1024 ** 3,
      os: `${os.platform()} ${os.release()} ${os.arch()}`,
    },
    browserVersion: browser.version(),
    headless: true,
    trace: {
      paintEvents: paints,
      drawFrameEvents: events.filter((e) => e.name === 'DrawFrame').length,
      note: 'Approximate browser paint evidence; Konva draw and rAF do not prove physical screen presentation.',
    },
    ...result,
  };
  await writeFile(testInfo.outputPath('benchmark.json'), JSON.stringify(report, null, 2));
  await writeFile(testInfo.outputPath('chromium-timeline.json'), content);
  await testInfo.attach('benchmark', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  if (process.env.WHITEBOARD_PERFORMANCE_GATE === '1')
    expect(result.stream.completeOperationToKonvaDrawMs.p95).toBeLessThan(50);
  expect(result.stream.phase).toBe('completed');
  expect(result.stream.applied).toBe(90);
  expect(result.stream.completeOperationToKonvaDrawMs.samples).toBe(90);
  expect(result.workload.visible500).toBe(500);
  expect(result.workload.visible5000).toBeLessThan(500);
  expect(result.stream.pendingDraws).toBe(0);
});
