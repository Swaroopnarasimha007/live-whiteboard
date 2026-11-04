import { expect, test, type Page } from '@playwright/test';
const board = (page: Page) => page.getByRole('application', { name: 'Whiteboard canvas' });

test('pan toggle stays in sync with the existing hand/select tools and preserves the scene', async ({
  page,
}) => {
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Pan mode', exact: true });
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).focus();
  await page.keyboard.press('Enter');
  const revision = await board(page).getAttribute('data-scene-revision');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(board(page)).toHaveCSS('cursor', 'grab');
  await expect(page.getByRole('button', { name: 'Hand', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await board(page).focus();
  await page.keyboard.press('h');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('v');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(board(page)).toHaveAttribute('data-scene-revision', revision!);
});
async function fixture(page: Page) {
  await page.getByText('Developer tools', { exact: true }).click();
  await page.getByRole('button', { name: 'Load renderer fixture' }).click();
  await expect(board(page)).toHaveAttribute('data-scene-revision', '1');
}
for (const [width, height] of [
  [1280, 720],
  [1920, 1080],
  [768, 1024],
  [390, 844],
])
  test(`canvas stays usable and page stays bounded at ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width: width!, height: height! });
    await page.goto('/');
    await expect(board(page)).toBeVisible();
    const box = (await board(page).boundingBox())!;
    expect(box.height).toBeGreaterThan(height! * 0.6);
    expect(box.width).toBeGreaterThan(width! * 0.6);
    const overflow = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth - innerWidth,
      height: document.documentElement.scrollHeight - innerHeight,
    }));
    expect(overflow.width).toBeLessThanOrEqual(1);
    expect(overflow.height).toBeLessThanOrEqual(1);
    await expect(page.getByRole('button', { name: 'Board panel', exact: true })).toHaveAttribute(
      'aria-expanded',
      width! >= 1100 ? 'true' : 'false',
    );
    await page.screenshot({ path: `test-results/ui-${width}.png` });
  });
test('small-screen panel closes with Escape, returns focus and leaves the canvas width intact', async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Board panel', exact: true });
  const before = (await board(page).boundingBox())!.width;
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Close board panel' })).toBeFocused();
  expect((await board(page).boundingBox())!.width).toBe(before);
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});
test('resizing collapses the side panel and the first keyboard stop can skip to the canvas', async ({
  page,
}) => {
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'Board panel', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to canvas' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(board(page)).toBeFocused();
});
test('keyboard can insert shapes, create a connection from the outline and edit properties', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(board(page)).toHaveAttribute('data-visible-nodes', '1');
  await page.getByRole('button', { name: 'Add circle', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(board(page)).toHaveAttribute('data-visible-nodes', '2');
  await page.getByText('Scene outline', { exact: true }).click();
  await page.getByRole('button', { name: 'Add arrow', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Connect Rectangle', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Connect Circle', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(board(page)).toHaveAttribute('data-visible-edges', '1');
  await page.getByRole('button', { name: 'Select Rectangle', exact: true }).focus();
  await page.keyboard.press('Enter');
  const width = page.getByRole('spinbutton', { name: 'Object width' });
  await width.fill('240');
  await page.getByRole('button', { name: 'Apply size', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(width).toHaveValue('240');
  await page.getByRole('button', { name: 'Color blue', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Object label' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit label', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Object label' })).toBeVisible();
});
test('grid, snap and follow remain independent and focused canvas gestures never scroll the page', async ({
  page,
}) => {
  await page.goto('/');
  await fixture(page);
  await page.getByRole('checkbox', { name: 'Grid', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Snap', exact: true })).not.toBeChecked();
  await expect(board(page)).toHaveAttribute('data-follow-live', 'true');
  await page.getByRole('checkbox', { name: 'Snap', exact: true }).check();
  await page.getByRole('button', { name: 'Pause live following' }).click();
  await expect(page.getByRole('checkbox', { name: 'Grid', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Snap', exact: true })).toBeChecked();
  const box = (await board(page).boundingBox())!;
  await board(page).focus();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 200);
  expect(await page.evaluate(() => [scrollX, scrollY])).toEqual([0, 0]);
  await expect(board(page)).toHaveAttribute('data-follow-live', 'false');
  await page.getByRole('button', { name: 'Resume live', exact: true }).click();
  await expect(board(page)).toHaveAttribute('data-follow-live', 'true');
});
test('controls have names, tooltips, 36px targets and visible keyboard focus; reduced motion is honored', async ({
  page,
}) => {
  await page.goto('/');
  const buttons = page.locator('button:visible');
  const problems = await buttons.evaluateAll((elements) =>
    elements
      .filter((element) => {
        const b = element.getBoundingClientRect();
        return (
          !(element.getAttribute('aria-label') || element.textContent)?.trim() ||
          b.width < 35.9 ||
          b.height < 35.9
        );
      })
      .map((element) => element.outerHTML),
  );
  expect(problems).toEqual([]);
  const tool = page.getByRole('button', { name: 'Add rectangle', exact: true });
  await tool.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  const style = await tool.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      outline: s.outlineWidth,
      title: el.getAttribute('title'),
      transition: s.transitionDuration,
    };
  });
  expect(style.outline).toBe('3px');
  expect(style.title).toBeTruthy();
  expect(style.transition).toBe('0s');
  await fixture(page);
  await page.getByText('Pan', { exact: true }).click();
  await page.getByRole('button', { name: 'Pan right', exact: true }).click();
  await page.getByRole('button', { name: 'Fit section', exact: true }).click();
  const first = await board(page).getAttribute('data-viewport-x');
  await page.waitForTimeout(80);
  expect(await board(page).getAttribute('data-viewport-x')).toBe(first);
});

for (const width of [1280, 768, 390]) {
  test(`panel expands left and preserves the live board at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(board(page)).toBeVisible();
    await page.getByRole('button', { name: 'Add rectangle', exact: true }).focus();
    await page.keyboard.press('Enter');
    const revision = await board(page).getAttribute('data-scene-revision');
    if (width < 1100) await page.getByRole('button', { name: 'Board panel', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Board information' });
    const before = (await panel.boundingBox())!;
    await page.getByRole('button', { name: 'Expand board panel', exact: true }).click();
    const expanded = (await panel.boundingBox())!;
    expect(expanded.width).toBeGreaterThan(before.width);
    expect(expanded.x).toBeLessThan(before.x);
    expect(expanded.x + expanded.width).toBeCloseTo(before.x + before.width, 0);
    await expect(board(page)).toHaveAttribute('data-scene-revision', revision!);
    await expect(page.getByRole('spinbutton', { name: 'Object width' })).toBeVisible();
    await page.getByRole('button', { name: 'Collapse board panel', exact: true }).click();
    expect((await panel.boundingBox())!.width).toBeCloseTo(before.width, 0);
    await expect(board(page)).toHaveAttribute('data-scene-revision', revision!);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
  });
}

for (const width of [1280, 390]) {
  test(`theme switching preserves board state and fits at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(board(page)).toBeVisible();
    await page.getByRole('button', { name: 'Add rectangle', exact: true }).focus();
    await page.keyboard.press('Enter');
    const revision = await board(page).getAttribute('data-scene-revision');
    const toggle = page.getByRole('switch', { name: 'Dark theme' });
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(page.locator('main.whiteboard-app')).toHaveAttribute('data-theme', 'dark');
    await expect(board(page)).toHaveAttribute('data-scene-revision', revision!);
    await expect(board(page)).toHaveAttribute('data-visible-nodes', '1');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `test-results/dark-${width}.png` });
    await page.reload();
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('main.whiteboard-app')).toHaveAttribute('data-theme', 'light');
  });
}
test('top bar reset keeps the existing confirmation behavior', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).focus();
  await page.keyboard.press('Enter');
  const reset = page.locator('.app-topbar').getByRole('button', { name: 'Reset session' });
  page.once('dialog', (dialog) => dialog.dismiss());
  await reset.click();
  await expect(board(page)).toHaveAttribute('data-visible-nodes', '1');
  page.once('dialog', (dialog) => dialog.accept());
  await reset.click();
  await expect(board(page)).toHaveAttribute('data-visible-nodes', '0');
});
