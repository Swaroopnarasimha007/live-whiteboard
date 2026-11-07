import { expect, test } from '@playwright/test';
for (const width of [1280, 768, 390]) {
  test(`split panel keeps transcript and tab navigation fixed at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    if (width < 1100) await page.getByRole('button', { name: 'Board panel', exact: true }).click();
    const transcript = page.getByRole('region', { name: 'Transcript', exact: true });
    await expect(transcript).toBeVisible();
    const tabs = page.getByRole('tablist');
    const before = await tabs.boundingBox();
    await page.getByRole('tab', { name: 'Document', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Export document' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send now', exact: true })).toBeHidden();
    await expect(page.getByRole('tabpanel')).toHaveCount(1);
    await page.getByRole('tab', { name: 'Session', exact: true }).click();
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: 'Developer tools' })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(page.getByRole('tab', { name: 'Session', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.locator('.panel-section-body').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    expect((await tabs.boundingBox())!.y).toBe(before!.y);
    await expect(transcript).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
  });
}
