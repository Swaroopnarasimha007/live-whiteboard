import { expect, test, type Page } from '@playwright/test';
async function harness(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/src/session/' + 'browserHarness.ts');
    await h.startHarness();
  });
  await page.getByRole('combobox', { name: 'Input mode' }).selectOption('mock');
  await expect(page.getByRole('application', { name: 'Whiteboard canvas' })).toBeVisible();
}
test('default mock tour needs no microphone, emits finalized segments and creates explicit topic sections', async ({
  page,
}) => {
  let microphoneCalls = 0;
  await page.exposeFunction('unexpectedMicrophone', () => {
    microphoneCalls++;
  });
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      await (window as unknown as { unexpectedMicrophone(): Promise<void> }).unexpectedMicrophone();
      throw new Error('Microphone must not be used');
    };
  });
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Input mode' }).selectOption('mock');
  await page.getByText('Transcript (0)', { exact: true }).click();
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  // The default tour now contains seven final-only segments over 14.4 seconds.
  // Interim/final scheduling is covered by deterministic controller/source fixtures.
  await expect(
    page.getByText('Segment 1: the browser sends a request to the API.', { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      Number(
        await page
          .getByRole('application', { name: 'Whiteboard canvas' })
          .getAttribute('data-scene-revision'),
      ),
    )
    .toBeGreaterThan(0);
  await page.getByText('Developer tools', { exact: true }).click();
  await page.getByText('Request inspector', { exact: true }).click();
  await expect(page.getByTestId('request-json')).toContainText('contextComplete');
  await expect(page.getByTestId('capture-state')).toHaveAttribute('data-state', 'idle', {
    timeout: 20000,
  });
  await expect(page.getByTestId('generation-state')).toHaveAttribute('data-state', 'idle');
  await expect(
    page.getByRole('button', { name: 'Segment 4 · Response', exact: true }),
  ).toBeVisible();
  expect(microphoneCalls).toBe(0);
  await page.screenshot({ path: 'test-results/agent-6-preview.png' });
});

test('fresh request inspector includes manual move/resize and defers until an edit commits', async ({
  page,
}) => {
  await harness(page);
  await page.evaluate(async () => {
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/session/' + 'browserHarness.ts'
    );
    h.loadFixture();
    h.editor.select('g_preview_r1_browser');
    h.editor.beginMove('g_preview_r1_browser', { x: 0, y: 0 });
    h.editor.previewMove({ x: 290, y: 135 });
    h.session.ingest({
      id: 'demo-database__manual',
      text: 'Query the database.',
      startMs: 0,
      endMs: 2000,
      isFinal: true,
    });
    h.session.sendNow();
  });
  await page.waitForTimeout(150);
  expect(
    await page.evaluate(
      async () =>
        (
          await import(/* @vite-ignore */ '/src/session/' + 'browserHarness.ts')
        ).activeHarness.session.getSnapshot().inspector,
    ),
  ).toBeNull();
  const request = await page.evaluate(async () => {
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/session/' + 'browserHarness.ts'
    );
    h.editor.commitGesture();
    await new Promise((resolve) => setTimeout(resolve, 100));
    return h.session.getSnapshot().inspector?.request;
  });
  expect(
    request?.board.nodes.find((n: { id: string }) => n.id === 'g_preview_r1_browser'),
  ).toMatchObject({ x: 290, y: 135 });
  expect(request?.board.selectedIds).toContain('g_preview_r1_browser');
});

test('confirmed reset during streaming clears transcript and late results cannot repopulate the board', async ({
  page,
}) => {
  await harness(page);
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.getByTestId('generation-state')).toHaveAttribute('data-state', 'streaming');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reset session', exact: true }).click();
  await expect(page.getByTestId('generation-state')).toHaveAttribute('data-state', 'idle');
  await page.waitForTimeout(1200);
  await expect(page.getByRole('application', { name: 'Whiteboard canvas' })).toHaveAttribute(
    'data-scene-revision',
    '0',
  );
  await expect(page.getByText('Transcript (0)', { exact: true })).toBeVisible();
});

test('context overflow visibly retains transcript while manual editing remains available', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { startHarness } = await import(/* @vite-ignore */ '/src/session/' + 'browserHarness.ts');
    const h = await startHarness(50);
    h.session.ingest({
      id: 'demo-browser__budget',
      text: 'Keep this transcript',
      startMs: 0,
      endMs: 1000,
      isFinal: true,
    });
    h.session.sendNow();
  });
  await expect(page.getByTestId('generation-state')).toHaveAttribute('data-state', 'paused');
  await expect(page.getByText(/Full context is/).first()).toBeVisible();
  const result = await page.evaluate(async () => {
    const { activeHarness: h } = await import(
      /* @vite-ignore */ '/src/session/' + 'browserHarness.ts'
    );
    h.editor.setTool('rect');
    return {
      queued: h.session.getSnapshot().queued[0]?.text,
      tool: h.editor.getSnapshot().tool,
      inspector: h.session.getSnapshot().inspector,
    };
  });
  expect(result).toEqual({ queued: 'Keep this transcript', tool: 'rect', inspector: null });
});
