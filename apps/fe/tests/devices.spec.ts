import { expect, test } from '@playwright/test';

test('devices: SSH Config field only appears for configRef auth mode (ui)', async ({ page }) => {
  await page.goto('/devices');
  await expect(page.getByTestId('devices-page')).toBeVisible();

  await page.getByTestId('devices-add').click();
  await expect(page.getByTestId('device-dialog')).toBeVisible();

  // 切换到 SSH 远程设备类型（默认认证方式落到 agent，非 configRef）
  await page.getByTestId('device-type-select').click();
  await page.getByRole('option', { name: 'SSH Remote Device', exact: true }).click();

  const sshConfigInput = page.getByTestId('device-ssh-config-ref-input');
  // 默认（agent）模式下 SSH Config 输入框不应出现
  await expect(sshConfigInput).toHaveCount(0);

  // 切换认证方式为 SSH Config，输入框出现
  await page.getByTestId('device-auth-mode-select').click();
  await page.getByRole('option', { name: 'SSH Config', exact: true }).click();
  await expect(sshConfigInput).toBeVisible();

  // 切回 SSH Agent，输入框再次消失（避免残留 sshConfigRef 被提交）
  await page.getByTestId('device-auth-mode-select').click();
  await page.getByRole('option', { name: 'SSH Agent', exact: true }).click();
  await expect(sshConfigInput).toHaveCount(0);
});

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
