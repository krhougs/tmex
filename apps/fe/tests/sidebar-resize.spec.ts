import { expect, test } from '@playwright/test';

test('sidebar: drag resizer to change width and persist across reload', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.getByTestId('sidebar');
  await expect(sidebar).toBeVisible();

  const resizer = page.getByTestId('sidebar-resizer');
  await expect(resizer).toBeAttached();

  const before = await sidebar.boundingBox();
  expect(before).not.toBeNull();

  const resizerBox = await resizer.boundingBox();
  expect(resizerBox).not.toBeNull();
  if (!resizerBox || !before) return;

  const startX = resizerBox.x + resizerBox.width / 2;
  const startY = resizerBox.y + resizerBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 80, startY, { steps: 5 });
  await page.mouse.up();

  await expect
    .poll(async () => (await sidebar.boundingBox())?.width ?? 0)
    .toBeCloseTo(before.width + 80, -1);

  // 宽度持久化在 localStorage，刷新后保持
  await page.reload();
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await expect
    .poll(async () => (await page.getByTestId('sidebar').boundingBox())?.width ?? 0)
    .toBeCloseTo(before.width + 80, -1);
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('mobile: sidebar sheet takes full viewport width', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Toggle Sidebar' }).click();

    const sheet = page.getByTestId('mobile-sidebar-sheet');
    await expect(sheet).toBeVisible();
    await expect
      .poll(async () => (await sheet.boundingBox())?.width ?? 0)
      .toBe(390);
  });
});
