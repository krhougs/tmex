import { expect, test } from '@playwright/test';

const ADMIN_PASSWORD = process.env.TMEX_E2E_ADMIN_PASSWORD ?? 'admin123';
const RUN_ID = process.env.TMEX_E2E_RUN_ID ?? `${Date.now()}`;

function sanitizeSessionName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('密码').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
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
  await page.getByLabel('认证方式').selectOption('password');
  await page.getByLabel('Tmux 会话名称').fill(deviceName);
  await page.getByRole('button', { name: '添加' }).click();

  await expect(page.getByRole('heading', { name: deviceName })).toBeVisible();
}

async function connectDevice(page: import('@playwright/test').Page, deviceName: string): Promise<void> {
  await page.goto('/devices');
  const deviceCardHeader = page
    .getByRole('heading', { name: deviceName })
    .locator('xpath=..')
    .locator('xpath=..');
  await deviceCardHeader.getByRole('link', { name: '连接' }).click();

  await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
}

async function ensureDeviceExpanded(
  page: import('@playwright/test').Page,
  deviceName: string
): Promise<import('@playwright/test').Locator> {
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
  return deviceItem;
}

async function cleanupSession(page: import('@playwright/test').Page, deviceName: string): Promise<void> {
  const isInvalidOverlayVisible = await page.getByText('当前目标不可用').isVisible().catch(() => false);
  if (isInvalidOverlayVisible) {
    return;
  }

  const terminal = page.locator('.xterm').first();
  const terminalVisible = await terminal.isVisible().catch(() => false);
  if (!terminalVisible) {
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
        r: parseInt(rgbMatch[1], 10),
        g: parseInt(rgbMatch[2], 10),
        b: parseInt(rgbMatch[3], 10),
      };
    }

    const rgbaMatch = color.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
    if (rgbaMatch) {
      return {
        r: parseInt(rgbaMatch[1], 10),
        g: parseInt(rgbaMatch[2], 10),
        b: parseInt(rgbaMatch[3], 10),
      };
    }

    if (color.startsWith('#')) {
      const hex = color.slice(1);
      if (hex.length === 3) {
        return {
          r: parseInt(hex[0] + hex[0], 16),
          g: parseInt(hex[1] + hex[1], 16),
          b: parseInt(hex[2] + hex[2], 16),
        };
      }
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
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
  test('设备树选中时应有 15% 高亮背景', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_contrast_${RUN_ID}`);

    await login(page);
    await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceName);

    const deviceItem = await ensureDeviceExpanded(page, deviceName);
    await expect(deviceItem).toHaveAttribute('data-active', 'true');

    const styles = await deviceItem.evaluate((el) => {
      const computed = window.getComputedStyle(el);
      return {
        backgroundColor: computed.backgroundColor,
      };
    });

    expect(styles.backgroundColor).toMatch(/^rgba\(88,\s*166,\s*255,\s*0\.15\)$/);

    await cleanupSession(page, deviceName);
  });

  test('Sidebar collapsed状态下图标应可见', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_collapsed_${RUN_ID}`);

    await login(page);
    await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceName);

    const collapseButton = page.getByRole('button', { name: /收起侧边栏/ });
    await expect(collapseButton).toBeVisible();
    await collapseButton.click();

    await page.waitForTimeout(400);

    const deviceIcon = page.locator(`[data-testid^="device-icon-"][title="${deviceName}"]`).first();
    await expect(deviceIcon).toBeVisible();
    await expect(deviceIcon).toHaveAttribute('data-active', 'true');

    const iconStyles = await deviceIcon.evaluate((el) => {
      const computed = window.getComputedStyle(el);
      return {
        backgroundColor: computed.backgroundColor,
        color: computed.color,
      };
    });

    const iconContrastRatio = getContrastRatio(iconStyles.backgroundColor, iconStyles.color);
    expect(iconContrastRatio).toBeGreaterThanOrEqual(4.5);

    await page.locator('.xterm').click();
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });

  test('窗口树选中时应叠加到 30% 高亮背景', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_win_contrast_${RUN_ID}`);

    await login(page);
    await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceName);

    await ensureDeviceExpanded(page, deviceName);

    const activeWindow = page.locator('[data-testid^="window-item-"][data-active="true"]').first();
    await expect(activeWindow).toBeVisible({ timeout: 30_000 });

    const windowStyles = await activeWindow.evaluate((el) => {
      const computed = window.getComputedStyle(el);
      return {
        backgroundColor: computed.backgroundColor,
      };
    });

    expect(windowStyles.backgroundColor).toMatch(/^rgba\(88,\s*166,\s*255,\s*0\.3\)$/);

    await cleanupSession(page, deviceName);
  });

  test('Pane项active状态应使用 90% 高亮背景', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_pane_contrast_${RUN_ID}`);

    await login(page);
    await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceName);

    await ensureDeviceExpanded(page, deviceName);

    const activePane = page.locator('[data-testid^="pane-item-"][data-active="true"]').first();
    await expect(activePane).toBeVisible({ timeout: 30_000 });

    const paneStyles = await activePane.evaluate((el) => {
      const computed = window.getComputedStyle(el);
      return {
        backgroundColor: computed.backgroundColor,
        color: computed.color,
      };
    });

    expect(paneStyles.backgroundColor).toMatch(/^rgba\(88,\s*166,\s*255,\s*0\.9\)$/);
    const paneContrastRatio = getContrastRatio(paneStyles.backgroundColor, paneStyles.color);
    expect(paneContrastRatio).toBeGreaterThanOrEqual(4.5);

    await cleanupSession(page, deviceName);
  });

  test('高亮设备项的新建窗口按钮应清晰可见且可点击', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_new_window_visible_${RUN_ID}`);

    await login(page);
    await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceName);

    const deviceItem = await ensureDeviceExpanded(page, deviceName);
    await expect(deviceItem).toHaveAttribute('data-active', 'true');

    const createWindowButton = page.getByRole('button', { name: `为设备 ${deviceName} 新建窗口` });
    await expect(createWindowButton).toBeVisible();
    await expect(createWindowButton).toBeEnabled();

    await createWindowButton.click();
    await page.waitForTimeout(1000);

    const windowItems = page.locator('[data-testid^="window-item-"]');
    await expect(windowItems).toHaveCount(2);

    await cleanupSession(page, deviceName);
  });

  test('关闭最后一个 pane 时应自动关闭对应 window', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_close_last_pane_${RUN_ID}`);

    await login(page);
    await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceName);

    await ensureDeviceExpanded(page, deviceName);
    const windowItemsBefore = page.locator('[data-testid^="window-item-"]');
    await expect(windowItemsBefore).toHaveCount(1);

    const windowTestId = await windowItemsBefore.first().getAttribute('data-testid');
    expect(windowTestId).toBeTruthy();

    const activePaneItem = page.locator('[data-testid^="pane-item-"][data-active="true"]').first();
    await expect(activePaneItem).toBeVisible({ timeout: 30_000 });
    await activePaneItem.getByRole('button', { name: /关闭 pane/ }).click();

    await page.waitForTimeout(1200);
    await expect(page.locator(`[data-testid="${windowTestId as string}"]`)).toHaveCount(0);

    await expect(page.getByRole('button', { name: /跳转到最新/ })).toBeDisabled();

    await page.goto('/devices');
    const deviceCardHeader = page
      .getByRole('heading', { name: deviceName })
      .locator('xpath=..')
      .locator('xpath=..');
    await deviceCardHeader.getByRole('link', { name: '连接' }).click();
    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    await cleanupSession(page, deviceName);
  });
});
