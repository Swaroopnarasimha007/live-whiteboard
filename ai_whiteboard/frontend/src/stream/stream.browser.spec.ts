import { expect, test } from '@playwright/test';

test('mock UI draws operations before response completion and reuses current board context', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByText('Developer tools', { exact: true }).click();
  await page.getByRole('button', { name: 'Run mock stream', exact: true }).click();
  const board = page.getByRole('application', { name: 'Whiteboard canvas' });
  await expect
    .poll(async () => Number(await board.getAttribute('data-last-drawn-revision')))
    .toBeGreaterThan(0);
  await expect(page.getByTestId('stream-phase')).toHaveText('receiving');
  await expect(page.getByTestId('stream-phase')).toHaveText('completed');
  await expect(board).toHaveAttribute('data-visible-nodes', '2');
  await expect(board).toHaveAttribute('data-visible-edges', '1');
  await page.getByRole('button', { name: 'Run mock stream', exact: true }).click();
  await expect(page.getByTestId('stream-phase')).toHaveText('completed');
  await expect(board).toHaveAttribute('data-scene-revision', '4');
  await expect(board).toHaveAttribute('data-last-drawn-revision', '4');
  await page.screenshot({ path: 'test-results/agent-5-preview.png' });
  expect(errors).toEqual([]);
});

test('cancel and explicit retry preserve accepted canvas work', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Developer tools', { exact: true }).click();
  await page.getByRole('button', { name: 'Run mock stream', exact: true }).click();
  const board = page.getByRole('application', { name: 'Whiteboard canvas' });
  await expect.poll(() => board.getAttribute('data-scene-revision')).not.toBe('0');
  await page.getByRole('button', { name: 'Cancel mock', exact: true }).click();
  await expect(page.getByTestId('stream-phase')).toHaveText('cancelled');
  const revision = await board.getAttribute('data-scene-revision');
  await page.waitForTimeout(180);
  await expect(board).toHaveAttribute('data-scene-revision', revision!);
  await page.getByRole('button', { name: 'Retry mock', exact: true }).click();
  await expect(page.getByTestId('stream-phase')).toHaveText('completed');
  await expect(board).toHaveAttribute('data-scene-revision', '4');
  await expect(board).toHaveAttribute('data-visible-nodes', '2');
});

test('browser byte faults recover and disconnected streams retry without duplicate objects', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByText('Developer tools', { exact: true }).click();
  const result = await page.evaluate(async () => {
    const { startHarness } = await import(/* @vite-ignore */ '/src/stream/' + 'browserHarness.ts');
    await startHarness();
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/stream/' + 'browserHarness.ts'
    );
    const { requestFor } = await import(/* @vite-ignore */ '/src/stream/' + 'test-helpers.ts');
    const { MockGenerationTransport } = await import(
      /* @vite-ignore */ '/src/stream/' + 'index.ts'
    );
    const request = requestFor(h.store);
    const options = {
      minChunkBytes: 1,
      maxChunkBytes: 3,
      lineDelayMs: 0,
      tailDelayMs: 0,
      malformedAfterRecord: 0,
    };
    const failed = await h.stream.consumer.consume(
      request,
      new MockGenerationTransport({ ...options, disconnectAfterBytes: 230 }),
    );
    const retry = await h.stream.consumer.consume(request, new MockGenerationTransport(options), {
      retry: true,
    });
    return {
      failed,
      retry,
      nodes: Object.keys(h.store.getSnapshot().nodes).length,
      edges: Object.keys(h.store.getSnapshot().edges).length,
    };
  });
  expect(result.failed.phase).toBe('error');
  expect(result.failed.stats.applied).toBeGreaterThan(0);
  expect(result.retry.phase).toBe('incomplete');
  expect(result.retry.stats.duplicates).toBeGreaterThan(0);
  expect(result.retry.stats.invalid).toBe(1);
  expect(result.nodes).toBe(2);
  expect(result.edges).toBe(1);
  const board = page.getByRole('application', { name: 'Whiteboard canvas' });
  await expect(board).toHaveAttribute('data-last-drawn-revision', '4');
});
