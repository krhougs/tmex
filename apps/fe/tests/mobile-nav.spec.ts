import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

test('mobile: topbar + sidebar sheet open/close', async ({ page }) => {
  await page.goto('/devices');
  await expect(page.getByTestId('devices-page')).toBeVisible();
  await expect(page.getByTestId('mobile-topbar')).toBeVisible();

  await page.getByTestId('mobile-sidebar-open').click();
  await expect(page.getByTestId('mobile-sidebar-sheet')).toBeVisible();

  await page.getByTestId('mobile-sidebar-close').click();
  await expect(page.getByTestId('mobile-sidebar-sheet')).toHaveCount(0);
});

