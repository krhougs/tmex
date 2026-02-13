import { expect, test } from '@playwright/test';

test('sidebar: delete device (confirm dialog)', async ({ page, request }) => {
  const name = `e2e-sidebar-delete-${Date.now()}`;

  const createRes = await request.post('/api/devices', {
    data: {
      name,
      type: 'local',
      session: 'tmex',
      authMode: 'auto',
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };

  await page.goto('/');
  const sidebar = page.getByTestId('sidebar');
  await expect(sidebar).toBeVisible();

  const deviceItem = sidebar.getByTestId(`device-item-${created.device.id}`);
  await expect(deviceItem).toBeVisible();

  await deviceItem.locator(`[data-testid="device-delete-${created.device.id}"]`).click();

  const dialog = page.locator('[data-slot="alert-dialog-content"]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(name);

  await dialog.locator('[data-slot="alert-dialog-action"]').click();
  await expect(deviceItem).toHaveCount(0);
});
