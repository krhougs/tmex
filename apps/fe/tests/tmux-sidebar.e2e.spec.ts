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

async function connectDevice(page: import('@playwright/test').Page, deviceId: string): Promise<void> {
  await page.goto('/devices');
  await page.getByTestId(`device-connect-${deviceId}`).click();
  await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, {
    timeout: 30_000,
  });
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
}

async function ensureDeviceExpanded(
  page: import('@playwright/test').Page,
  deviceId: string
): Promise<import('@playwright/test').Locator> {
  const deviceItem = page.getByTestId(`device-item-${deviceId}`).first();
  await expect(deviceItem).toBeVisible({ timeout: 30_000 });

  const windowItems = page.locator('[data-testid^="window-item-"]');
  if ((await windowItems.count()) === 0) {
    await page.getByTestId(`device-expand-${deviceId}`).first().click();
  }

  await expect(windowItems.first()).toBeVisible({ timeout: 30_000 });
  return deviceItem;
}

async function cleanupSession(page: import('@playwright/test').Page, deviceName: string): Promise<void> {
  const terminal = page.locator('.xterm').first();
  if ((await terminal.isVisible().catch(() => false)) === false) {
    return;
  }

  await terminal.click();
  await page.waitForTimeout(500);
  await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
  await page.keyboard.press('Enter');
}

function getContrastRatio(color1: string, color2: string): number {
  const parseColor = (color: string): { r: number; g: number; b: number } => {
    const rgbMatch = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgbMatch) {
      return {
        r: Number.parseInt(rgbMatch[1], 10),
        g: Number.parseInt(rgbMatch[2], 10),
        b: Number.parseInt(rgbMatch[3], 10),
      };
    }

    const rgbaMatch = color.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
    if (rgbaMatch) {
      return {
        r: Number.parseInt(rgbaMatch[1], 10),
        g: Number.parseInt(rgbaMatch[2], 10),
        b: Number.parseInt(rgbaMatch[3], 10),
      };
    }

    if (color.startsWith('#')) {
      const hex = color.slice(1);
      if (hex.length === 3) {
        return {
          r: Number.parseInt(hex[0] + hex[0], 16),
          g: Number.parseInt(hex[1] + hex[1], 16),
          b: Number.parseInt(hex[2] + hex[2], 16),
        };
      }
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
      };
    }

    return { r: 0, g: 0, b: 0 };
  };

  const getLuminance = (r: number, g: number, b: number): number => {
    const rsRGB = r / 255;
    const gsRGB = g / 255;
    const bsRGB = b / 255;

    const rLinear = rsRGB <= 0.03928 ? rsRGB / 12.92 : Math.pow((rsRGB + 0.055) / 1.055, 2.4);
    const gLinear = gsRGB <= 0.03928 ? gsRGB / 12.92 : Math.pow((gsRGB + 0.055) / 1.055, 2.4);
    const bLinear = bsRGB <= 0.03928 ? bsRGB / 12.92 : Math.pow((bsRGB + 0.055) / 1.055, 2.4);

    return 0.2126 * rLinear + 0.7152 * gLinear + 0.0722 * bLinear;
  };

  const c1 = parseColor(color1);
  const c2 = parseColor(color2);

  const l1 = getLuminance(c1.r, c1.g, c1.b);
  const l2 = getLuminance(c2.r, c2.g, c2.b);

  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);

  return (lighter + 0.05) / (darker + 0.05);
}

test.describe('Sidebar - 可读性和对比度', () => {
  test('设备树选中时应有可区分的高亮背景', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_contrast_${RUN_ID}`);

    await openDevices(page);
    const deviceId = await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceId);

    const deviceItem = await ensureDeviceExpanded(page, deviceId);

    const styles = await deviceItem.evaluate((element) => {
      const computed = window.getComputedStyle(element);
      const parent = element.parentElement ?? document.body;
      const parentStyle = window.getComputedStyle(parent);
      return {
        backgroundColor: computed.backgroundColor,
        textColor: computed.color,
        parentBackground: parentStyle.backgroundColor,
      };
    });

    const contrastRatio = getContrastRatio(styles.textColor, styles.backgroundColor);
    expect(contrastRatio).toBeGreaterThan(2.5);

    await cleanupSession(page, deviceName);
  });
});

test.describe('Sidebar - 行为', () => {
  test('应能通过 Sidebar 新建窗口', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_new_win_${RUN_ID}`);

    await openDevices(page);
    const deviceId = await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceId);

    await ensureDeviceExpanded(page, deviceId);

    const windowItems = page.locator('[data-testid^="window-item-"]');
    await expect(windowItems.first()).toBeVisible({ timeout: 30_000 });
    const initialCount = await windowItems.count();

    await page.getByTestId(`window-create-${deviceId}`).click();
    await expect(windowItems).toHaveCount(initialCount + 1, { timeout: 30_000 });

    await cleanupSession(page, deviceName);
  });

  test('关闭最后一个 pane 时应自动关闭对应 window', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_close_last_pane_${RUN_ID}`);

    await openDevices(page);
    const deviceId = await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceId);

    await ensureDeviceExpanded(page, deviceId);

    const windowItemsBefore = page.locator('[data-testid^="window-item-"]');
    const windowCountBefore = await windowItemsBefore.count();
    expect(windowCountBefore).toBeGreaterThanOrEqual(1);

    const activePaneItem = page
      .locator('[data-testid^="pane-item-"][data-active="true"]')
      .first();
    await expect(activePaneItem).toBeVisible({ timeout: 30_000 });

    const paneTestId = await activePaneItem.getAttribute('data-testid');
    if (!paneTestId) {
      throw new Error('Pane ID not found');
    }
    const paneId = paneTestId.replace('pane-item-', '');

    await page.getByTestId(`pane-close-${paneId}`).click();

    await expect(windowItemsBefore).toHaveCount(windowCountBefore - 1, {
      timeout: 30_000,
    });
    await expect(page.getByTestId('terminal-jump-latest')).toBeDisabled();

    await page.goto('/devices');
    await page.getByTestId(`device-connect-${deviceId}`).click();
    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, {
      timeout: 30_000,
    });

    await cleanupSession(page, deviceName);
  });

  test('Sidebar 展开与折叠态底部按钮都应左对齐', async ({ page }) => {
    await page.goto('/devices');

    const manageDeviceLink = page.getByTestId('sidebar-manage-devices').first();
    await expect(manageDeviceLink).toBeVisible();
    const manageDeviceJustify = await manageDeviceLink.evaluate((element) => {
      return window.getComputedStyle(element).justifyContent;
    });
    expect(manageDeviceJustify).toBe('flex-start');

    const settingsLink = page.getByTestId('sidebar-settings').first();
    await expect(settingsLink).toBeVisible();
    const settingsJustify = await settingsLink.evaluate((element) => {
      return window.getComputedStyle(element).justifyContent;
    });
    expect(settingsJustify).toBe('flex-start');

    const collapseButton = page.getByTestId('sidebar-collapse-toggle').first();
    await collapseButton.click();

    const collapsedManageDeviceLink = page.getByTestId('sidebar-manage-devices').first();
    await expect(collapsedManageDeviceLink).toBeVisible();
    const collapsedManageDeviceJustify = await collapsedManageDeviceLink.evaluate((element) => {
      return window.getComputedStyle(element).justifyContent;
    });
    expect(collapsedManageDeviceJustify).toBe('flex-start');

    const collapsedSettingsLink = page.getByTestId('sidebar-settings').first();
    await expect(collapsedSettingsLink).toBeVisible();
    const collapsedSettingsJustify = await collapsedSettingsLink.evaluate((element) => {
      return window.getComputedStyle(element).justifyContent;
    });
    expect(collapsedSettingsJustify).toBe('flex-start');
  });

  test('不同设备存在相同 window/pane id 时仅当前设备高亮', async ({ page }) => {
    const deviceA = sanitizeSessionName(`e2e_cross_highlight_a_${RUN_ID}`);
    const deviceB = sanitizeSessionName(`e2e_cross_highlight_b_${RUN_ID}`);

    await openDevices(page);
    const deviceAId = await addLocalDevice(page, deviceA);
    const deviceBId = await addLocalDevice(page, deviceB);

    await connectDevice(page, deviceAId);
    await connectDevice(page, deviceBId);

    await expect(page.locator('[data-testid^="window-item-"][data-active="true"]')).toHaveCount(1);
    await expect(page.locator('[data-testid^="pane-item-"][data-active="true"]')).toHaveCount(1);

    await cleanupSession(page, deviceB);
    await cleanupSession(page, deviceA);
  });

  test('设备列表应按名称排序且不受连接状态影响', async ({ page }) => {
    const deviceA = sanitizeSessionName(`aaa_order_${RUN_ID}`);
    const deviceZ = sanitizeSessionName(`zzz_order_${RUN_ID}`);

    await openDevices(page);
    const deviceAId = await addLocalDevice(page, deviceA);
    const deviceZId = await addLocalDevice(page, deviceZ);

    await connectDevice(page, deviceZId);
    await page.goto('/devices');

    await expect(page.getByTestId(`device-item-${deviceAId}`)).toBeVisible();
    await expect(page.getByTestId(`device-item-${deviceZId}`)).toBeVisible();

    const deviceNameButtons = page.locator('[data-testid^="device-select-"]');
    const orderedNames = await deviceNameButtons.allTextContents();
    const indexA = orderedNames.findIndex((name) => name.trim() === deviceA);
    const indexZ = orderedNames.findIndex((name) => name.trim() === deviceZ);

    expect(indexA).toBeGreaterThanOrEqual(0);
    expect(indexZ).toBeGreaterThanOrEqual(0);
    expect(indexA).toBeLessThan(indexZ);

    await cleanupSession(page, deviceZ);
  });
});
