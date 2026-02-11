import { expect, test } from '@playwright/test';

const RUN_ID = process.env.TMEX_E2E_RUN_ID ?? `${Date.now()}`;

function sanitizeSessionName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function openDevices(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/devices');
  await page.waitForURL(/\/devices/);
}

async function addLocalDevice(
  page: import('@playwright/test').Page,
  deviceName: string
): Promise<string> {
  await page.goto('/devices');
  await page.getByTestId('devices-add').first().click();

  await page.getByTestId('device-name-input').fill(deviceName);
  await page.getByTestId('device-type-select').selectOption('local');
  await page.getByTestId('device-session-input').fill(deviceName);
  await page.getByTestId('device-dialog-save').click();

  const deviceCard = page
    .locator(`[data-testid="device-card"][data-device-name="${deviceName}"]`)
    .first();
  await expect(deviceCard).toBeVisible({ timeout: 30_000 });

  const deviceId = await deviceCard.getAttribute('data-device-id');
  if (!deviceId) {
    throw new Error('Device ID not found');
  }
  return deviceId;
}

async function openDeviceTerminal(
  page: import('@playwright/test').Page,
  deviceId: string
): Promise<void> {
  await page.goto('/devices');
  await page.getByTestId(`device-connect-${deviceId}`).click();
  await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, {
    timeout: 30_000,
  });
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
}

async function ensureDeviceTreeExpanded(
  page: import('@playwright/test').Page,
  deviceId: string
): Promise<void> {
  const deviceItem = page.getByTestId(`device-item-${deviceId}`).first();
  await expect(deviceItem).toBeVisible({ timeout: 30_000 });

  const windowItems = page.locator('[data-testid^="window-item-"]');
  if ((await windowItems.count()) === 0) {
    await page.getByTestId(`device-expand-${deviceId}`).first().click();
  }

  await expect(windowItems.first()).toBeVisible({ timeout: 30_000 });
}

async function terminalType(page: import('@playwright/test').Page, text: string): Promise<void> {
  const terminal = page.locator('.xterm');
  await expect(terminal).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('terminal-status-overlay')).not.toBeVisible({ timeout: 30_000 });
  await terminal.click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

async function expectWindowCount(
  page: import('@playwright/test').Page,
  expected: number
): Promise<void> {
  await expect(page.locator('[data-testid^="window-item-"]')).toHaveCount(expected, {
    timeout: 30_000,
  });
}

test('浏览器可连接本地 tmux，并能窗口/分屏操作', async ({ page }) => {
  const deviceName = sanitizeSessionName(`e2e_local_${RUN_ID}`);
  await page.addInitScript(() => {
    window.localStorage.removeItem('tmex-ui');
  });

  await openDevices(page);
  const deviceId = await addLocalDevice(page, deviceName);

  await openDeviceTerminal(page, deviceId);
  await ensureDeviceTreeExpanded(page, deviceId);

  await terminalType(page, 'tmux new-window -n e2e-win');
  await expectWindowCount(page, 2);

  const windowItems = page.locator('[data-testid^="window-item-"]');
  await windowItems.nth(1).click();
  await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/(?:%(?:25)?\d+|\d+)$/);

  await terminalType(page, 'tmux split-window -h');

  const paneButtons = page.locator('[data-testid^="pane-item-"]');
  await expect(paneButtons).toHaveCount(2, { timeout: 30_000 });

  await paneButtons.nth(1).click();
  await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/(?:%(?:25)?\d+|\d+)$/);

  await terminalType(page, 'tmux kill-window -t :1');
  await expectWindowCount(page, 1);

  await terminalType(page, 'tmux kill-session || true');
});
