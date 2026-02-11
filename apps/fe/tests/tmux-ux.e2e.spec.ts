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

async function cleanupSession(page: import('@playwright/test').Page, deviceName: string): Promise<void> {
  await page.locator('.xterm').click();
  await page.waitForTimeout(500);
  await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
  await page.keyboard.press('Enter');
}

test.describe('Terminal 白屏修复', () => {
  test('直接通过 URL 冷启动进入应正确显示 terminal', async ({ page, context }) => {
    const deviceName = sanitizeSessionName(`e2e_coldstart_${RUN_ID}`);

    await openDevices(page);
    await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceName);

    const currentUrl = page.url();

    const newPage = await context.newPage();
    await openDevices(newPage);
    await newPage.goto(currentUrl);

    await newPage.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
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
    await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceName);

    const activeWindow = page.locator('[data-testid^="window-item-"][data-active="true"]').first();
    await expect(activeWindow).toBeVisible({ timeout: 30_000 });

    await cleanupSession(page, deviceName);
  });

  test('应能通过 Sidebar 切换 window', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_switch_win_${RUN_ID}`);
    const windowName = `e2e_win_${RUN_ID}`;

    await openDevices(page);
    await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceName);

    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type(`tmux new-window -n ${windowName}`);
    await page.keyboard.press('Enter');

    const newWindowItem = page
      .locator('[data-testid^="window-item-"]')
      .filter({ hasText: windowName })
      .first();
    await expect(newWindowItem).toBeVisible({ timeout: 30_000 });

    await newWindowItem.click();
    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });
    await expect(newWindowItem).toHaveAttribute('data-active', 'true');

    const windowItems = page.locator('[data-testid^="window-item-"]');
    await expect(windowItems).toHaveCount(2, { timeout: 30_000 });

    const firstWindow = windowItems.nth(0);
    const firstText = (await firstWindow.textContent()) ?? '';
    const fallbackWindow = firstText.includes(windowName) ? windowItems.nth(1) : firstWindow;
    await fallbackWindow.click();

    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });

    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type('tmux kill-window -t :1 || true');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });

  test('应能通过 Sidebar 新建窗口', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_new_win_${RUN_ID}`);

    await openDevices(page);
    await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceName);

    const windowItems = page.locator('[data-testid^="window-item-"]');
    await expect(windowItems.first()).toBeVisible({ timeout: 30_000 });
    const initialCount = await windowItems.count();

    const newWindowButton = page.locator('[title="新建窗口"]').first();
    await expect(newWindowButton).toBeVisible();
    await newWindowButton.click();

    await expect(windowItems).toHaveCount(initialCount + 1, { timeout: 30_000 });

    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type('tmux kill-window -t :1 || true');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await page.keyboard.type(`tmux kill-session -t ${deviceName} || true`);
    await page.keyboard.press('Enter');
  });

  test('Pane 列表应正确显示和切换', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_pane_${RUN_ID}`);

    await openDevices(page);
    await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceName);

    await page.locator('.xterm').click();
    await page.waitForTimeout(500);
    await page.keyboard.type('tmux split-window -h');
    await page.keyboard.press('Enter');

    const paneButtons = page.locator('[data-testid^="pane-item-"]');
    await expect
      .poll(async () => paneButtons.count(), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);

    await paneButtons.nth(1).click();
    await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/[^/]+$/, { timeout: 30_000 });

    await cleanupSession(page, deviceName);
  });
});

test.describe('响应式布局', () => {
  test('调整浏览器宽度不应导致页面不可用', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_resize_${RUN_ID}`);

    await openDevices(page);
    await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceName);

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
        const menuButton = page.locator('header button').first();
        await expect(menuButton).toBeVisible();
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
    await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceName);

    await page.getByRole('button', { name: /编辑器/ }).click();

    const editor = page.locator('.editor-mode-input textarea');
    await expect(editor).toBeVisible();

    await editor.fill('echo pc_editor_mode_ok');
    await page.getByRole('button', { name: /^发送$/ }).click();

    await page.waitForTimeout(800);
    await expect(page.locator('.xterm')).toBeVisible();

    await cleanupSession(page, deviceName);
  });

  test('编辑器应提供快捷键并可直接发送', async ({ page }) => {
    const deviceName = sanitizeSessionName(`e2e_editor_shortcut_${RUN_ID}`);

    await page.setViewportSize({ width: 1280, height: 800 });
    await openDevices(page);
    await addLocalDevice(page, deviceName);
    await connectDevice(page, deviceName);

    await page.getByRole('button', { name: /编辑器/ }).click();

    const shortcutRow = page.getByTestId('editor-shortcuts-row');
    await expect(shortcutRow).toBeVisible();
    await expect(shortcutRow.getByRole('button', { name: /发送 CTRL\+C/ })).toBeVisible();
    await expect(shortcutRow.getByRole('button', { name: /发送 ESC/ })).toBeVisible();
    await expect(shortcutRow.getByRole('button', { name: /发送 CTRL\+D/ })).toBeVisible();
    await expect(shortcutRow.getByRole('button', { name: /发送 SHIFT\+ENTER/ })).toBeVisible();

    await shortcutRow.getByRole('button', { name: /发送 CTRL\+C/ }).click();
    await page.waitForTimeout(200);

    await cleanupSession(page, deviceName);
  });
});
