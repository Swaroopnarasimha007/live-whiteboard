import { expect, test } from '@playwright/test';

test('foundation renders without application errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Live Whiteboard', exact: true })).toBeVisible();
  await expect(page.getByRole('application', { name: 'Whiteboard canvas' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start session', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Start demo', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});
