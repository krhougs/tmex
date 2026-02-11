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
): Promise<void> {
  await page.goto('/devices');
  await page.getByRole('button', { name: '添加设备' }).first().click();

  await page.getByLabel('设备名称').fill(deviceName);
  await page.getByLabel('类型').selectOption('local');
  await page.getByLabel('Tmux 会话名称').fill(deviceName);
  await page.getByRole('button', { name: '添加' }).click();

  await expect(page.getByRole('heading', { name: deviceName })).toBeVisible();
}

async function openDeviceTerminal(
  page: import('@playwright/test').Page,
  deviceName: string
): Promise<void> {
  await page.goto('/devices');

  const deviceCardHeader = page
    .getByRole('heading', { name: deviceName })
    .locator('xpath=..')
    .locator('xpath=..');
  await deviceCardHeader.getByRole('link', { name: '连接' }).click();

  await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
}

async function ensureDeviceTreeExpanded(
  page: import('@playwright/test').Page,
  deviceName: string
): Promise<void> {
  const deviceItem = page
    .locator('[data-testid^="device-item-"]')
    .filter({ hasText: deviceName })
    .first();
  await expect(deviceItem).toBeVisible({ timeout: 30_000 });

  const windowItems = page.locator('[data-testid^="window-item-"]');
  if ((await windowItems.count()) === 0) {
    await deviceItem.locator('button').first().click();
  }

  await expect(windowItems.first()).toBeVisible({ timeout: 30_000 });
}

async function terminalType(page: import('@playwright/test').Page, text: string): Promise<void> {
  const terminal = page.locator('.xterm');
  await expect(terminal).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('连接中...')).not.toBeVisible({ timeout: 30_000 });
  await terminal.click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

async function waitForWindowVisible(
  page: import('@playwright/test').Page,
  windowName: string
): Promise<void> {
  const windowItem = page
    .locator('[data-testid^="window-item-"]')
    .filter({ hasText: windowName })
    .first();
  await expect(windowItem).toBeVisible({ timeout: 30_000 });
}

async function waitForWindowHidden(
  page: import('@playwright/test').Page,
  windowName: string
): Promise<void> {
  const windowItem = page
    .locator('[data-testid^="window-item-"]')
    .filter({ hasText: windowName })
    .first();
  await expect(windowItem).not.toBeVisible({ timeout: 30_000 });
}

test('浏览器可连接本地 tmux，并能窗口/分屏操作', async ({ page }) => {
  const deviceName = sanitizeSessionName(`e2e_local_${RUN_ID}`);
  const windowName = `e2e_win_${RUN_ID}`;
  await page.addInitScript(() => {
    window.localStorage.removeItem('tmex-ui');
  });

  await openDevices(page);
  await addLocalDevice(page, deviceName);

  await openDeviceTerminal(page, deviceName);
  await ensureDeviceTreeExpanded(page, deviceName);

  await terminalType(page, `tmux new-window -n ${windowName}`);
  await waitForWindowVisible(page, windowName);

  const windowItem = page
    .locator('[data-testid^="window-item-"]')
    .filter({ hasText: windowName })
    .first();
  await windowItem.click();
  await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/(?:%(?:25)?\d+|\d+)$/);

  await terminalType(page, 'tmux split-window -h');
  await page.waitForTimeout(2000);

  const paneButtons = page.locator('[data-testid^="pane-item-"]');
  await expect(paneButtons).toHaveCount(2, { timeout: 30_000 });

  await paneButtons.nth(1).click();
  await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/(?:%(?:25)?\d+|\d+)$/);

  await terminalType(page, 'tmux kill-window -t :1');
  await waitForWindowHidden(page, windowName);

  await terminalType(page, 'tmux kill-session || true');

});
