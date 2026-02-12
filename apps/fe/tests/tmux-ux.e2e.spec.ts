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

test.describe('Terminal 白屏修复', () => {
  test('直接通过 URL 冷启动进入应正确显示 terminal', async ({ page, context }) => {
    const deviceName = sanitizeSessionName(`e2e_coldstart_${RUN_ID}`);

    await openDevices(page);
    const deviceId = await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceId);

    const currentUrl = page.url();

    const newPage = await context.newPage();
    await openDevices(newPage);
    await newPage.goto(currentUrl);

    await newPage.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, {
      timeout: 30_000,
    });
    await newPage.waitForTimeout(2000);

    await expect(newPage.locator('.xterm')).toBeVisible({ timeout: 30_000 });
    await expect(newPage.locator('.xterm-screen')).toBeVisible({ timeout: 30_000 });

    await newPage.locator('.xterm').click();
    await newPage.keyboard.type('echo coldstart_test');

    await newPage.close();
    await cleanupSession(page, deviceName);
  });
});

test.describe('Sidebar 功能', () => {
  test('高亮样式应清晰可见', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_highlight_${RUN_ID}`);

    await openDevices(page);
    const deviceId = await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceId);

    const activeWindow = page.locator('[data-testid^="window-item-"][data-active="true"]').first();
    await expect(activeWindow).toBeVisible({ timeout: 30_000 });

    await cleanupSession(page, deviceName);
  });

  test('应能通过 Sidebar 切换 window', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_switch_win_${RUN_ID}`);

    await openDevices(page);
    const deviceId = await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceId);

    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type('tmux new-window -n e2e-window');
    await page.keyboard.press('Enter');

    const windowItems = page.locator('[data-testid^="window-item-"]');
    await expect(windowItems).toHaveCount(2, { timeout: 30_000 });

    const secondWindow = windowItems.nth(1);
    await secondWindow.click();
    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, {
      timeout: 30_000,
    });
    await expect(secondWindow).toHaveAttribute('data-active', 'true');

    const firstWindow = windowItems.nth(0);
    await firstWindow.click();
    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, {
      timeout: 30_000,
    });

    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type('tmux kill-window -t :1 || true');
    await page.keyboard.press('Enter');

    await cleanupSession(page, deviceName);
  });

  test('应能通过 Sidebar 新建窗口', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_new_win_${RUN_ID}`);

    await openDevices(page);
    const deviceId = await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceId);

    const windowItems = page.locator('[data-testid^="window-item-"]');
    await expect(windowItems.first()).toBeVisible({ timeout: 30_000 });
    const initialCount = await windowItems.count();

    const newWindowButton = page.getByTestId(`window-create-${deviceId}`);
    await expect(newWindowButton).toBeVisible();
    await newWindowButton.click();

    await expect(windowItems).toHaveCount(initialCount + 1, { timeout: 30_000 });

    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type('tmux kill-window -t :1 || true');
    await page.keyboard.press('Enter');

    await cleanupSession(page, deviceName);
  });

  test('Pane 列表应正确显示和切换', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_pane_${RUN_ID}`);

    await openDevices(page);
    const deviceId = await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceId);

    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type('tmux split-window -h');
    await page.keyboard.press('Enter');

    const paneButtons = page.locator('[data-testid^="pane-item-"]');
    await expect
      .poll(async () => paneButtons.count(), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);

    await paneButtons.nth(1).click();
    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, {
      timeout: 30_000,
    });

    await cleanupSession(page, deviceName);
  });
});

test.describe('响应式布局', () => {
  test('调整浏览器宽度不应导致页面不可用', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_resize_${RUN_ID}`);

    await openDevices(page);
    const deviceId = await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceId);

    const sizes = [
      { width: 1920, height: 1080 },
      { width: 1366, height: 768 },
      { width: 1280, height: 720 },
      { width: 1024, height: 768 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
    ];

    for (const size of sizes) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.waitForTimeout(200);

      await expect(page.locator('.xterm')).toBeVisible();

      await page.locator('.xterm').click();
      await page.keyboard.type(' ');

      if (size.width < 768) {
        await expect(page.getByTestId('mobile-sidebar-open')).toBeVisible();
      }
    }

    await page.setViewportSize({ width: 1280, height: 720 });
    await cleanupSession(page, deviceName);
  });
});

test.describe('输入模式切换', () => {
  test('PC 上应支持切换到编辑器并发送内容', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_editor_pc_${RUN_ID}`);

    await page.setViewportSize({ width: 1280, height: 800 });
    await openDevices(page);
    const deviceId = await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceId);

    await page.getByTestId('terminal-input-mode-toggle').click();

    const editor = page.getByTestId('editor-input');
    await expect(editor).toBeVisible();
    await expect(page.getByTestId('editor-send-line-by-line')).toBeVisible();
    await expect(page.getByTestId('editor-send-row')).toBeVisible();

    const sendRowChildren = page.locator('[data-testid="editor-send-row"] > *');
    await expect(sendRowChildren).toHaveCount(4);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('editor-send-row')).toBeVisible();
    await expect(page.getByTestId('editor-shortcuts-row')).toBeVisible();

    const sendWithEnterCheckbox = page
      .getByTestId('editor-send-with-enter-toggle')
      .locator('input[type="checkbox"]');
    await expect(sendWithEnterCheckbox).toBeChecked();

    await editor.fill('echo pc_editor_mode_ok');
    await page.getByTestId('editor-send').click();

    await page.waitForTimeout(800);
    await expect(page.locator('.xterm')).toBeVisible();

    await page.locator('.xterm').click();
    await page.keyboard.type('echo editor_direct_mode_ok');
    await page.keyboard.press('Enter');

    await expect
      .poll(async () => (await page.locator('.xterm-screen').textContent()) ?? '', { timeout: 15_000 })
      .toContain('editor_direct_mode_ok');

    await cleanupSession(page, deviceName);
  });

  test('编辑器应提供快捷键并可直接发送', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_editor_shortcut_${RUN_ID}`);

    await page.setViewportSize({ width: 1280, height: 800 });
    await openDevices(page);
    const deviceId = await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceId);

    const shortcutStrip = page.getByTestId('terminal-shortcuts-strip');
    const shortcutRow = page.getByTestId('editor-shortcuts-row');
    await expect(shortcutStrip).toBeVisible();
    await expect(shortcutRow).toBeVisible();
    await expect(page.getByTestId('editor-shortcut-ctrl-c')).toBeVisible();

    await expect(shortcutStrip).toHaveCSS('overflow-x', 'auto');
    await expect(shortcutRow).toHaveCSS('flex-wrap', 'nowrap');
    await expect(page.getByTestId('editor-shortcut-ctrl-c')).toHaveCSS('user-select', 'none');

    await page.getByTestId('terminal-input-mode-toggle').click();

    await expect(shortcutStrip).toBeVisible();
    await expect(shortcutRow).toBeVisible();
    await expect(page.getByTestId('editor-shortcut-ctrl-c')).toBeVisible();
    await expect(page.getByTestId('editor-shortcut-esc')).toBeVisible();
    await expect(page.getByTestId('editor-shortcut-ctrl-d')).toBeVisible();
    await expect(page.getByTestId('editor-shortcut-shift-enter')).toBeVisible();
    await expect(page.getByTestId('editor-send-line-by-line')).toBeVisible();

    await page.getByTestId('editor-input').fill('echo line_send_one\necho line_send_two');
    await page.getByTestId('editor-send-line-by-line').click();

    await expect
      .poll(async () => (await page.locator('.xterm-screen').textContent()) ?? '', { timeout: 15_000 })
      .toContain('line_send_one');
    await expect
      .poll(async () => (await page.locator('.xterm-screen').textContent()) ?? '', { timeout: 15_000 })
      .toContain('line_send_two');

    await page.getByTestId('editor-shortcut-ctrl-c').click();
    await page.waitForTimeout(200);

    await cleanupSession(page, deviceName);
  });

  test('切换输入模式后终端应自动滚动到最新', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_editor_scroll_latest_${RUN_ID}`);

    await page.setViewportSize({ width: 1280, height: 800 });
    await openDevices(page);
    const deviceId = await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceId);

    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type('for i in $(seq 1 120); do echo e2e_scroll_$i; done');
    await page.keyboard.press('Enter');

    const viewport = page.locator('.xterm-viewport').first();
    await expect(viewport).toBeVisible();

    await page.waitForTimeout(800);
    await viewport.evaluate((el) => {
      el.scrollTop = 0;
    });

    await page.getByTestId('terminal-input-mode-toggle').click();

    await page.waitForTimeout(200);
    const scrollInfo = await viewport.evaluate((el) => ({
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }));

    expect(Math.abs(scrollInfo.scrollHeight - scrollInfo.clientHeight - scrollInfo.scrollTop)).toBeLessThanOrEqual(8);

    await cleanupSession(page, deviceName);
  });
});

test.describe('iOS Meta', () => {
  test('应包含 PWA 全屏与 viewport-fit meta', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    const viewportContent = await page.evaluate(() => {
      const meta = document.querySelector('meta[name=\"viewport\"]');
      return meta?.getAttribute('content') ?? '';
    });
    expect(viewportContent).toContain('viewport-fit=cover');

    const appleCapable = await page.evaluate(() => {
      const meta = document.querySelector('meta[name=\"apple-mobile-web-app-capable\"]');
      return meta?.getAttribute('content') ?? '';
    });
    expect(appleCapable).toBe('yes');

    const statusBarStyle = await page.evaluate(() => {
      const meta = document.querySelector('meta[name=\"apple-mobile-web-app-status-bar-style\"]');
      return meta?.getAttribute('content') ?? '';
    });
    expect(statusBarStyle).toBe('black-translucent');

    const manifestHref = await page.evaluate(() => {
      const link = document.querySelector('link[rel=\"manifest\"]');
      return link?.getAttribute('href') ?? '';
    });
    expect(manifestHref).toContain('/api/manifest.webmanifest');

    const appleTouchIconHref = await page.evaluate(() => {
      const link = document.querySelector('link[rel=\"apple-touch-icon\"]');
      return link?.getAttribute('href') ?? '';
    });
    expect(appleTouchIconHref).toContain('/tmex.png');

    const standaloneDataAttr = await page.evaluate(() => {
      return document.documentElement.dataset.tmexStandalone ?? '';
    });
    expect(standaloneDataAttr).toBe('0');

    const safeAreaTopVar = await page.evaluate(() => {
      return getComputedStyle(document.documentElement).getPropertyValue('--tmex-safe-area-top').trim();
    });
    expect(safeAreaTopVar).toBe('0px');

    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('tmex:sonner', {
          detail: {
            title: 'safe-area toast probe',
          },
        })
      );
    });
    await page.waitForSelector('[data-sonner-toaster]', { state: 'attached' });

    const toasterOffsets = await page.evaluate(() => {
      const toaster = document.querySelector('[data-sonner-toaster]') as HTMLElement | null;
      return toaster?.getAttribute('style') ?? '';
    });
    expect(toasterOffsets).toContain('--offset-top: calc(16px + var(--tmex-safe-area-top))');
    expect(toasterOffsets).toContain('--mobile-offset-top: calc(12px + var(--tmex-safe-area-top))');
  });

  test('manifest 名称应跟随站点设置动态变化', async ({ request }) => {
    const originalRes = await request.get('/api/settings/site');
    expect(originalRes.ok()).toBeTruthy();
    const originalJson = (await originalRes.json()) as {
      settings: {
        siteName: string;
        siteUrl: string;
        bellThrottleSeconds: number;
        enableBrowserBellToast: boolean;
        enableTelegramBellPush: boolean;
        sshReconnectMaxRetries: number;
        sshReconnectDelaySeconds: number;
        language: 'en_US' | 'zh_CN';
      };
    };

    const originalSettings = originalJson.settings;
    const tempSiteName = `tmex-e2e-manifest-${RUN_ID}`;

    try {
      const patchRes = await request.patch('/api/settings/site', {
        data: { siteName: tempSiteName },
      });
      expect(patchRes.ok()).toBeTruthy();

      const manifestRes = await request.get('/api/manifest.webmanifest');
      expect(manifestRes.ok()).toBeTruthy();
      expect((manifestRes.headers()['content-type'] ?? '').toLowerCase()).toContain(
        'application/manifest+json'
      );

      const manifest = (await manifestRes.json()) as {
        name: string;
        short_name: string;
      };
      expect(manifest.name).toBe(tempSiteName);
      expect(manifest.short_name).toBe(tempSiteName);
    } finally {
      const restoreRes = await request.patch('/api/settings/site', {
        data: {
          siteName: originalSettings.siteName,
          siteUrl: originalSettings.siteUrl,
          bellThrottleSeconds: originalSettings.bellThrottleSeconds,
          enableBrowserBellToast: originalSettings.enableBrowserBellToast,
          enableTelegramBellPush: originalSettings.enableTelegramBellPush,
          sshReconnectMaxRetries: originalSettings.sshReconnectMaxRetries,
          sshReconnectDelaySeconds: originalSettings.sshReconnectDelaySeconds,
          language: originalSettings.language,
        },
      });
      expect(restoreRes.ok()).toBeTruthy();
    }
  });
});
