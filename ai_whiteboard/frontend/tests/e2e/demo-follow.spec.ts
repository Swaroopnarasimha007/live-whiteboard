import { expect, test } from '@playwright/test';

test('four-segment demo follows each created and edited segment', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.evaluate(async () => {
    const h = await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts');
    await h.start({ mock: { lineDelayMs: 0, tailDelayMs: 0 } });
  });
  for (const [event, number] of [
    ['tour-1', 1],
    ['tour-2', 2],
    ['tour-3', 3],
    ['tour-edit-1', 1],
    ['tour-4', 4],
    ['tour-add-2', 2],
    ['tour-edit-4', 4],
  ] as const) {
    await page.evaluate(async (id) => {
      (await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts')).submit([id]);
    }, event);
    await expect(page.getByTestId('generation-state')).toHaveAttribute('data-state', 'idle');
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const { active } = await import(/* @vite-ignore */ '/tests/e2e/' + 'browserHarness.ts');
          const camera = active.viewport.getSnapshot();
          return active.store.getSnapshot().sections[camera.liveSectionId!]?.title;
        }),
      )
      .toContain(`Segment ${number} ·`);
    await expect(page.getByRole('application')).toHaveAttribute('data-follow-live', 'true');
  }
});
