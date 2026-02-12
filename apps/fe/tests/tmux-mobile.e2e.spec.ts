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

test.describe('移动端布局', () => {
  test('iPhone 尺寸下顶栏不应挤在一起', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_mobile_header_${RUN_ID}`);

    await page.setViewportSize({ width: 390, height: 844 });

    await openDevices(page);
    const deviceId = await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceId);

    const header = page.getByTestId('mobile-topbar');
    const headerBox = await header.boundingBox();
    expect(headerBox).toBeTruthy();
    await expect(header).toHaveClass(/tmex-mobile-topbar/);
    await expect(header.locator('..')).toHaveClass(/tmex-mobile-topbar-spacer/);

    await expect(page.getByTestId('mobile-sidebar-open')).toBeVisible();

    const title = page.getByTestId('mobile-topbar-title');
    await expect(title).toBeVisible();
    await expect(title).toHaveText(/\d+\/\d+:\s+[^@]+@.+/);

    await expect(page.locator('header')).toHaveCount(1);
    await expect(header.getByTestId('terminal-input-mode-toggle')).toBeVisible();
    await expect(header.getByTestId('terminal-jump-latest')).toBeVisible();

    await expect(header).toHaveCSS('position', 'fixed');

    await page.locator('.xterm').click();
    await page.keyboard.type('echo mobile_test');
    await page.keyboard.press('Enter');

    await page.waitForTimeout(500);
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });

  test('iPad 尺寸下布局应正常', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_ipad_${RUN_ID}`);

    await page.setViewportSize({ width: 768, height: 1024 });

    await openDevices(page);
    const deviceId = await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceId);

    const sidebar = page.locator('aside');
    await expect(sidebar).toBeVisible();

    await page.locator('.xterm').click();
    await page.keyboard.type('echo ipad_test');
    await page.keyboard.press('Enter');

    await page.waitForTimeout(500);
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });

  test('折叠的 Sidebar 图标应清晰可见', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_sidebar_${RUN_ID}`);

    await page.setViewportSize({ width: 1280, height: 720 });

    await openDevices(page);
    const deviceId = await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceId);

    const collapseButton = page.getByTestId('sidebar-collapse-toggle').first();
    await collapseButton.click();
    await page.waitForTimeout(500);

    const sidebar = page.locator('aside');
    await expect(sidebar).toBeVisible();
    await expect(page.getByTestId(`device-icon-${deviceId}`)).toBeVisible();

    await collapseButton.click();
    await page.waitForTimeout(500);

    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });

  test('折叠 Sidebar 底部按钮在 visualViewport scroll 风暴下应保持稳定', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_sidebar_jitter_${RUN_ID}`);

    await page.setViewportSize({ width: 1280, height: 720 });

    await openDevices(page);
    const deviceId = await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceId);

    const collapseButton = page.getByTestId('sidebar-collapse-toggle').first();
    await collapseButton.click();
    await expect(page.getByTestId(`device-icon-${deviceId}`)).toBeVisible();

    const manageButton = page.getByTestId('sidebar-manage-devices');
    await expect(manageButton).toBeVisible();
    const beforeBox = await manageButton.boundingBox();
    expect(beforeBox).toBeTruthy();

    await page.evaluate(() => {
      const proto = CSSStyleDeclaration.prototype as CSSStyleDeclaration & {
        __tmexOriginalSetProperty?: CSSStyleDeclaration['setProperty'];
      };

      if (!proto.__tmexOriginalSetProperty) {
        proto.__tmexOriginalSetProperty = proto.setProperty;
      }

      let viewportWriteCount = 0;
      const originalSetProperty = proto.__tmexOriginalSetProperty;

      proto.setProperty = function (
        propertyName: string,
        value: string | null,
        priority?: string
      ): void {
        if (propertyName === '--tmex-viewport-height') {
          viewportWriteCount += 1;
        }
        originalSetProperty.call(this, propertyName, value, priority);
      };

      (window as Window & { __tmexViewportWriteCount?: () => number }).__tmexViewportWriteCount = () =>
        viewportWriteCount;
      (window as Window & { __tmexRestoreViewportPatch?: () => void }).__tmexRestoreViewportPatch = () => {
        proto.setProperty = originalSetProperty;
      };
    });

    await page.evaluate(() => {
      if (!window.visualViewport) {
        return;
      }

      for (let i = 0; i < 40; i += 1) {
        window.visualViewport.dispatchEvent(new Event('scroll'));
      }
    });

    await page.waitForTimeout(100);
    const viewportWriteCount = await page.evaluate(
      () =>
        (window as Window & { __tmexViewportWriteCount?: () => number }).__tmexViewportWriteCount?.() ?? 0
    );
    expect(viewportWriteCount).toBeLessThanOrEqual(1);

    const afterBox = await manageButton.boundingBox();
    expect(afterBox).toBeTruthy();
    expect(Math.abs((afterBox?.y ?? 0) - (beforeBox?.y ?? 0))).toBeLessThanOrEqual(1);

    await page.evaluate(() => {
      (window as Window & { __tmexRestoreViewportPatch?: () => void }).__tmexRestoreViewportPatch?.();
    });

    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });
});
