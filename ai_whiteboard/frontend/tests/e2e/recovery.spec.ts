import { expect, test } from '@playwright/test';
test('developer generation namespaces stay fresh after import and reset', async ({ page }) => {
  await page.goto('/tests/harness.html');
  const results = await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts');
    await h.start();
    const first = h.active.loadFixture();
    const exported = h.active.document.exportText();
    h.active.document.importText(exported, true);
    h.active.session.reset({ confirmed: true });
    const afterReset = h.active.loadFixture();
    h.active.session.reset({ confirmed: true });
    const mock = await h.active.stream.run();
    h.active.session.reset({ confirmed: true });
    const nextMock = await h.active.stream.run();
    return { first, afterReset, mock: mock?.phase, nextMock: nextMock?.phase };
  });
  expect(results.first.status).toBe('applied');
  expect(results.afterReset.status).toBe('applied');
  expect(results.mock).toBe('completed');
  expect(results.nextMock).toBe('completed');
});
test('autosaved drawing survives reload and invalid import preserves it', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  await page.reload();
  await expect(page.getByRole('application')).toHaveAttribute('data-visible-nodes', '1');
  page.once('dialog', (d) => d.accept());
  await page.getByLabel('Import whiteboard JSON').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"bad":true}'),
  });
  await expect(page.getByText(/Import failed/)).toBeVisible();
  await expect(page.getByRole('application')).toHaveAttribute('data-visible-nodes', '1');
});
test('malformed/missing references and stalled transport have visible bounded recovery', async ({
  page,
}) => {
  await page.goto('/tests/harness.html');
  await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts');
    await h.start({
      mock: {
        fixture: [
          { op: 'section.add', id: 's', title: 'Failures' },
          '{bad',
          { op: 'edge.add', id: 'missing', section: 's', from: 'unknown_a', to: 'unknown_b' },
        ],
        lineDelayMs: 0,
        tailDelayMs: 0,
      },
    });
    h.submit();
  });
  await expect(page.getByTestId('generation-state')).toHaveAttribute('data-state', 'error');
  const failures = await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts');
    return {
      pending: h.active.store.getPendingCount(),
      result: h.active.session.getSnapshot().lastResult,
    };
  });
  expect(failures.pending).toBe(0);
  expect(failures.result.stats.invalid).toBe(1);
  expect(failures.result.stats.rejected).toBe(1);
  await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts');
    h.active.dispose();
    await h.start({ stall: true });
    h.submit();
  });
  await expect(page.getByTestId('generation-state')).toHaveAttribute('data-state', 'streaming');
  await page.getByRole('button', { name: 'Stop session', exact: true }).click();
  await expect(page.getByTestId('generation-state')).toHaveAttribute('data-state', 'error');
  await expect(page.getByRole('button', { name: 'Retry request', exact: true })).toBeEnabled();
});
