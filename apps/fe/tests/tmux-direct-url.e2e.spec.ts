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

async function connectDeviceAndGetPaneUrl(
  page: import('@playwright/test').Page,
  deviceId: string
): Promise<string> {
  await page.goto('/devices');
  await page.getByTestId(`device-connect-${deviceId}`).click();
  await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, {
    timeout: 30_000,
  });
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });
  return page.url();
}

test.describe('直接URL访问 - 白屏检测', () => {
  test('从设备页URL直接访问应显示终端内容', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_direct_${RUN_ID}`);

    await openDevices(page);
    const deviceId = await addLocalDevice(page, deviceName);

    await page.goto('/devices');
    await page.getByTestId(`device-connect-${deviceId}`).click();

    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, {
      timeout: 30_000,
    });
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    const currentUrl = page.url();

    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type('echo direct_url_test_content');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    const urlMatch = currentUrl.match(/\/devices\/([^/]+)\/windows\/([^/]+)\/panes\/([^/]+)$/);
    expect(urlMatch).not.toBeNull();

    await page.goto(currentUrl);

    await expect(page.locator('.xterm')).toBeVisible({ timeout: 3_000 });

    const bodyBg = await page.evaluate(() => {
      return window.getComputedStyle(document.body).backgroundColor;
    });
    expect(bodyBg).not.toBe('rgb(255, 255, 255)');

    const xtermContent = await page.locator('.xterm-screen').textContent();
    expect(xtermContent).not.toBeNull();

    const loadingVisible = await page
      .getByTestId('terminal-status-overlay')
      .isVisible()
      .catch(() => false);
    if (loadingVisible) {
      await expect(page.getByTestId('terminal-status-overlay')).not.toBeVisible({
        timeout: 10_000,
      });
    }

    await expect(page.locator('.xterm')).toBeVisible();
    await page.locator('.xterm').click();
    await page.keyboard.type('echo still_working');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);

    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });

  test('直接访问应正确解码双重编码的pane ID', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_decode_${RUN_ID}`);

    await openDevices(page);
    const deviceId = await addLocalDevice(page, deviceName);

    await page.goto('/devices');
    await page.getByTestId(`device-connect-${deviceId}`).click();

    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, {
      timeout: 30_000,
    });
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 30_000 });

    const originalUrl = page.url();
    const urlMatch = originalUrl.match(/\/devices\/([^/]+)\/windows\/([^/]+)\/panes\/([^/]+)$/);
    expect(urlMatch).not.toBeNull();

    const [, , , originalPaneId] = urlMatch!;

    const doubleEncodedPaneId = encodeURIComponent(encodeURIComponent(originalPaneId));
    const doubleEncodedUrl = `${page.url().split('/panes/')[0]}/panes/${doubleEncodedPaneId}`;

    await page.goto(doubleEncodedUrl);

    await expect(page.locator('.xterm')).toBeVisible({ timeout: 10_000 });

    const errorAlert = await page.locator('[role="alert"]').isVisible().catch(() => false);
    expect(errorAlert).toBe(false);

    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });

  test('直接访问无pane ID的设备页应自动选择第一个pane', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_autoselect_${RUN_ID}`);

    await openDevices(page);
    const deviceId = await addLocalDevice(page, deviceName);

    await page.goto('/devices');
    await page.getByTestId(`device-connect-${deviceId}`).click();

    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, {
      timeout: 30_000,
    });

    const fullUrl = page.url();
    const baseUrl = fullUrl.split('/windows/')[0];
    await page.goto(baseUrl);

    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, {
      timeout: 10_000,
    });

    await expect(page.locator('.xterm')).toBeVisible({ timeout: 10_000 });

    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });

  test('冷启动直链不应连接到其他设备', async ({ page, browser }) => {
    const deviceAName = sanitizeSessionName(`e2e_direct_a_${RUN_ID}`);
    const deviceBName = sanitizeSessionName(`e2e_direct_b_${RUN_ID}`);

    await openDevices(page);
    const deviceAId = await addLocalDevice(page, deviceAName);
    const deviceBId = await addLocalDevice(page, deviceBName);

    const directUrlA = await connectDeviceAndGetPaneUrl(page, deviceAId);
    const directUrlB = await connectDeviceAndGetPaneUrl(page, deviceBId);

    const matchA = directUrlA.match(/\/devices\/([^/]+)\/windows\/([^/]+)\/panes\/([^/]+)$/);
    const matchB = directUrlB.match(/\/devices\/([^/]+)\/windows\/([^/]+)\/panes\/([^/]+)$/);
    expect(matchA).not.toBeNull();
    expect(matchB).not.toBeNull();

    const [, directAId] = matchA!;
    const [, directBId] = matchB!;

    const coldPage = await browser.newPage();
    const connectDeviceIds: string[] = [];

    coldPage.on('websocket', (ws) => {
      ws.on('framesent', (event) => {
        const raw =
          typeof event.payload === 'string' ? event.payload : event.payload.toString();
        try {
          const msg = JSON.parse(raw) as {
            type?: string;
            payload?: { deviceId?: string };
          };
          if (msg.type === 'device/connect' && msg.payload?.deviceId) {
            connectDeviceIds.push(msg.payload.deviceId);
          }
        } catch {
          // ignore non-json frames
        }
      });
    });

    await coldPage.goto(directUrlA);
    await coldPage.waitForURL(
      new RegExp(`/devices/${directAId}/windows/[^/]+/panes/[^/]+$`),
      { timeout: 30_000 }
    );
    await expect(coldPage.locator('.xterm')).toBeVisible({ timeout: 30_000 });
    await coldPage.waitForTimeout(1_200);

    expect(connectDeviceIds.includes(directAId)).toBe(true);
    expect(connectDeviceIds.includes(directBId)).toBe(false);

    await coldPage.close();

    await page.goto(directUrlA);
    await page.locator('.xterm').click();
    await page.waitForTimeout(300);
    await page.keyboard.type(`tmux kill-session -t ${deviceAName} || true`);
    await page.keyboard.press('Enter');
    await page.keyboard.type(`tmux kill-session -t ${deviceBName} || true`);
    await page.keyboard.press('Enter');
  });
});
