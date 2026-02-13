import { expect, test } from '@playwright/test';

test('devices: create/edit/delete local device (ui)', async ({ page }) => {
  const initialName = `e2e-local-${Date.now()}`;
  const updatedName = `${initialName}-updated`;

  await page.goto('/devices');
  await expect(page.getByTestId('devices-page')).toBeVisible();

  await page.getByTestId('devices-add').click();
  await expect(page.getByTestId('device-dialog')).toBeVisible();

  await page.getByTestId('device-name-input').fill(initialName);
  await page.getByTestId('device-dialog-save').click();

  const createdCard = page.locator(`[data-testid="device-card"][data-device-name="${initialName}"]`);
  await expect(createdCard).toBeVisible();

  const deviceId = await createdCard.getAttribute('data-device-id');
  expect(deviceId).toBeTruthy();

  await createdCard.locator(`[data-testid="device-card-actions-${deviceId}"]`).click();
  await page.getByTestId(`device-card-edit-${deviceId}`).click();
  await expect(page.getByTestId('device-dialog')).toBeVisible();
  await page.getByTestId('device-name-input').fill(updatedName);
  await page.getByTestId('device-dialog-save').click();

  await expect(page.locator(`[data-device-name="${updatedName}"]`)).toBeVisible();

  const updatedCard = page.locator(
    `[data-testid="device-card"][data-device-name="${updatedName}"]`
  );
  await updatedCard.locator(`[data-testid="device-card-actions-${deviceId}"]`).click();
  await page.getByTestId(`device-card-delete-${deviceId}`).click();

  const dialog = page.locator('[data-slot="alert-dialog-content"]');
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-slot="alert-dialog-action"]').click();

  await expect(
    page.locator(`[data-testid="device-card"][data-device-name="${updatedName}"]`)
  ).toHaveCount(0);
});
