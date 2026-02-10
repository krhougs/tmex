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

  // 等待设备卡片出现，使用 heading 更精确
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
  const toggle = page.getByRole('button', { name: deviceName });
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  // 等待自动展开或手动点击
  await page.waitForTimeout(1000);
  // 检查是否已经展开（通过检查是否存在窗口按钮）
  const windowButton = page.getByRole('button', { name: /\d+: / }).first();
  const isVisible = await windowButton.isVisible().catch(() => false);
  if (!isVisible) {
    await toggle.click();
    await expect(page.getByRole('button', { name: /\d+: / }).first()).toBeVisible({ timeout: 30_000 });
  }
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
  // 窗口按钮可能包含 "当前窗口" 后缀
  await expect(
    page.getByRole('button', { name: new RegExp(`\\d+:\\s*${windowName}`) }).first()
  ).toBeVisible({
    timeout: 30_000,
  });
}

async function waitForWindowHidden(
  page: import('@playwright/test').Page,
  windowName: string
): Promise<void> {
  // 窗口按钮可能包含 "当前窗口" 后缀
  await expect(
    page.getByRole('button', { name: new RegExp(`\\d+:\\s*${windowName}`) }).first()
  ).not.toBeVisible({
    timeout: 30_000,
  });
}

function getPaneButtonsInWindow(windowButton: import('@playwright/test').Locator) {
  return windowButton.locator('xpath=..').locator('.tree-children > button.tree-item');
}

test('浏览器可连接本地 tmux，并能窗口/分屏操作', async ({ page }) => {
  const deviceName = sanitizeSessionName(`e2e_local_${RUN_ID}`);
  const windowName = `e2e_win_${RUN_ID}`;
  const errors: Error[] = [];

  await page.addInitScript(() => {
    window.localStorage.removeItem('tmex-ui');
  });

  page.on('pageerror', (err) => {
    errors.push(err);
  });

  await login(page);
  await addLocalDevice(page, deviceName);

  await openDeviceTerminal(page, deviceName);
  await ensureDeviceTreeExpanded(page, deviceName);

  await terminalType(page, `tmux new-window -n ${windowName}`);
  await waitForWindowVisible(page, windowName);

  const windowButton = page.getByRole('button', { name: new RegExp(`\\d+:\\s*${windowName}`) }).first();
  await windowButton.click();
  await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/(?:%(?:25)?\d+|\d+)$/);

  await terminalType(page, 'tmux split-window -h');
  await page.waitForTimeout(2000);

  // 使用 pane-item 类选择 pane 按钮
  const paneButtons = page.locator('.pane-item');
  await expect(paneButtons).toHaveCount(2, { timeout: 30_000 });

  await paneButtons.nth(1).click();
  await page.waitForURL(/\/devices\/[^/]+\/windows\/[^/]+\/panes\/(?:%(?:25)?\d+|\d+)$/);

  // 使用窗口索引 1 来关闭窗口（0 是默认窗口，1 是新建的窗口）
  await terminalType(page, 'tmux kill-window -t :1');
  await waitForWindowHidden(page, windowName);

  // 清理：杀死当前会话
  await terminalType(page, 'tmux kill-session || true');

  expect(errors, `页面出现未捕获异常: ${errors.map((e) => e.message).join('\n')}`).toEqual([]);
});
