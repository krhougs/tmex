import { expect, test } from '@playwright/test';
import { ensureCleanSession, tmux } from './helpers/tmux';

function createTwoWindowSession(sessionName: string): {
  paneId: string;
  windowId: string;
  backgroundWindowId: string;
} {
  ensureCleanSession(sessionName);
  tmux(`new-session -d -s ${sessionName} "sh -lc 'echo PANE0_READY; exec sh'"`);
  tmux(`new-window -t ${sessionName} "sh -lc 'echo WIN1_READY; exec sh'"`);
  tmux(`select-window -t ${sessionName}:0`);

  const paneId = tmux(`list-panes -t ${sessionName}:0 -F '#{pane_id}'`).trim();
  const windowIds = tmux(`list-windows -t ${sessionName} -F '#{window_id}'`)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return { paneId, windowId: windowIds[0], backgroundWindowId: windowIds[1] };
}

test('sidebar: window tab follows terminal title and supports rename via menu', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-rename-${Date.now()}`;
  const { paneId, windowId, backgroundWindowId } = createTwoWindowSession(sessionName);

  const createRes = await request.post('/api/devices', {
    data: {
      name: `e2e-rename-${Date.now()}`,
      type: 'local',
      session: sessionName,
      authMode: 'auto',
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  try {
    await page.goto(
      `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`
    );
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });

    const windowItem = page.getByTestId(`window-item-${windowId}`);
    await expect(windowItem).toBeVisible();

    // 终端通过 OSC 2 设置标题后，sidebar tab 跟随显示
    const oscTitle = `osc-title-${Date.now()}`;
    tmux(`send-keys -t ${sessionName}:0.0 "printf '\\033]2;${oscTitle}\\007'" Enter`);
    await expect(windowItem).toContainText(oscTitle, { timeout: 20_000 });

    // 非活跃窗口的 OSC 标题同样跟随显示
    const bgOscTitle = `bg-osc-${Date.now()}`;
    tmux(`send-keys -t ${sessionName}:1 "printf '\\033]2;${bgOscTitle}\\007'" Enter`);
    await expect(page.getByTestId(`window-item-${backgroundWindowId}`)).toContainText(bgOscTitle, {
      timeout: 20_000,
    });

    // 经 ⋮ 菜单重命名
    const customName = `custom-${Date.now()}`;
    await page.getByTestId(`window-menu-${windowId}`).click();
    await page.getByTestId(`window-menu-rename-${windowId}`).click();

    const renameDialog = page.getByTestId('window-rename-dialog');
    await expect(renameDialog).toBeVisible();
    const input = page.getByTestId('window-rename-input');
    await input.fill('');
    // 空名时保存按钮禁用
    await expect(page.getByTestId('window-rename-save')).toBeDisabled();
    await input.fill(customName);
    await page.getByTestId('window-rename-save').click();
    await expect(renameDialog).toBeHidden();

    // 自定义名覆盖终端标题，sidebar 与浏览器标题同步更新
    await expect(windowItem).toContainText(customName, { timeout: 20_000 });
    await expect.poll(() => page.title()).toContain(customName);

    // 刷新页面后自定义名仍在（持久化在 gateway 内存中）
    await page.reload();
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`window-item-${windowId}`)).toContainText(customName, {
      timeout: 20_000,
    });

    // 恢复自动名称后重新跟随终端标题
    await page.getByTestId(`window-menu-${windowId}`).click();
    await page.getByTestId(`window-menu-rename-${windowId}`).click();
    await expect(page.getByTestId('window-rename-dialog')).toBeVisible();
    await page.getByTestId('window-rename-reset').click();
    await expect(page.getByTestId('window-rename-dialog')).toBeHidden();
    await expect(page.getByTestId(`window-item-${windowId}`)).toContainText(oscTitle, {
      timeout: 20_000,
    });
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
