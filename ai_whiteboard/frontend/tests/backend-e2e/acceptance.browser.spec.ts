import { test, expect } from '@playwright/test';
test('mock PCM crosses real audio and generation routes into the existing canvas; reset releases capture', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const harness = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
    await harness.startHarness();
  });
  await page.getByRole('combobox', { name: 'Input mode' }).selectOption('backend');
  await expect(page.getByLabel('Speech profile')).toBeVisible();
  await page.getByRole('button', { name: 'Hold to talk', exact: true }).focus();
  await page.keyboard.down('Space');
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
        return (Object.values(h.runtime.store.getSnapshot().nodes) as { label: string }[]).map(
          (n) => n.label,
        );
      }),
    )
    .toContain('Database');
  const snapshot = await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
    return {
      observed: h.observed,
      session: h.runtime.session.getSnapshot(),
      backend: h.runtime.backend.getSnapshot(),
    };
  });
  expect(
    snapshot.observed.some(
      (s: { nodes: number; inFlight: boolean; phase: string }) =>
        s.nodes > 0 && s.inFlight && s.phase !== 'completed',
    ),
  ).toBe(true);
  expect(snapshot.session.inspector.request.sessionId).toMatch(/^bs_/);
  expect(snapshot.backend.identity.profile).toBe('mock');
  await expect(page.getByRole('application', { name: 'Whiteboard canvas' })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reset session', exact: true }).click();
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const h = await import(/* @vite-ignore */ '/tests/backend-e2e/' + 'harness.ts');
        return {
          epoch: h.runtime.store.getSessionEpoch(),
          nodes: Object.keys(h.runtime.store.getSnapshot().nodes).length,
          captures: h.activeCaptures,
        };
      }),
    )
    .toEqual({ epoch: 1, nodes: 0, captures: 0 });
});
