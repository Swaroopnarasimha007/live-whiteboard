import { expect, test } from '@playwright/test';
test('navigation, keyboard shape insertion and permission fallback', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  const board = page.getByRole('application');
  await expect(board).toBeVisible();
  await page.getByRole('button', { name: 'Add rectangle', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(board).toHaveAttribute('data-visible-nodes', '1');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(board).toHaveAttribute('data-viewport-scale', '1.2');
  await page.getByRole('checkbox', { name: 'Grid', exact: true }).check();
  await page.evaluate(() => {
    if (navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException('Denied', 'NotAllowedError');
      };
  });
  await page.getByRole('combobox', { name: 'Input mode' }).selectOption('microphone');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.getByTestId('capture-state')).toHaveAttribute('data-state', 'error');
  await page.getByRole('combobox', { name: 'Input mode' }).selectOption('mock');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.getByTestId('capture-state')).toHaveAttribute('data-state', 'recording');
  await page.getByRole('button', { name: 'Stop session', exact: true }).click();
  expect(errors).toEqual([]);
});
