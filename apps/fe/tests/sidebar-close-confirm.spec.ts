import { expect, test } from '@playwright/test';
import { ensureCleanSession, tmux } from './helpers/tmux';

function createTwoWindowSession(sessionName: string): {
  paneIds: string[];
  windowIds: string[];
} {
  ensureCleanSession(sessionName);
  tmux(`new-session -d -s ${sessionName} "sh -lc 'echo PANE0_READY; exec sh'"`);
  tmux(`split-window -h -t ${sessionName} "sh -lc 'echo PANE1_READY; exec sh'"`);
  tmux(`new-window -t ${sessionName} "sh -lc 'echo WIN1_READY; exec sh'"`);
  tmux(`select-window -t ${sessionName}:0`);
  tmux(`select-pane -t ${sessionName}:0.0`);

  const paneIds = tmux(`list-panes -t ${sessionName}:0 -F '#{pane_id}'`)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const windowIds = tmux(`list-windows -t ${sessionName} -F '#{window_id}'`)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return { paneIds, windowIds };
}

test('sidebar: close window/pane requires confirm dialog', async ({ page, request }) => {
  const sessionName = `tmex-e2e-close-${Date.now()}`;
  const { paneIds, windowIds } = createTwoWindowSession(sessionName);
  expect(paneIds.length).toBe(2);
  expect(windowIds.length).toBe(2);

  const createRes = await request.post('/api/devices', {
    data: {
      name: `e2e-close-confirm-${Date.now()}`,
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
      `/devices/${deviceId}/windows/${windowIds[0]}/panes/${encodeURIComponent(paneIds[0])}`
    );
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });

    const dialog = page.locator('[data-slot="alert-dialog-content"]');

    // 关 pane：取消后 pane 仍在
    const paneItem = page.getByTestId(`pane-item-${paneIds[1]}`);
    await expect(paneItem).toBeVisible();
    await page.getByTestId(`pane-close-${paneIds[1]}`).click();
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-slot="alert-dialog-cancel"]').click();
    await expect(dialog).toBeHidden();
    await expect(paneItem).toBeVisible();

    // 关 pane：确认后 pane 被关闭（单 pane 窗口不再渲染 pane 列表）
    await page.getByTestId(`pane-close-${paneIds[1]}`).click();
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-slot="alert-dialog-action"]').click();
    await expect(paneItem).toHaveCount(0, { timeout: 20_000 });
    expect(tmux(`list-panes -t ${sessionName}:0 -F '#{pane_id}'`).split(/\r?\n/).length).toBe(1);

    // 关非选中窗口：确认后从列表消失，tmux 只剩一个窗口
    const window2Item = page.getByTestId(`window-item-${windowIds[1]}`);
    await expect(window2Item).toBeVisible();
    await page.getByTestId(`window-close-${windowIds[1]}`).click();
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-slot="alert-dialog-action"]').click();
    await expect(window2Item).toHaveCount(0, { timeout: 20_000 });
    expect(tmux(`list-windows -t ${sessionName} -F '#{window_id}'`).split(/\r?\n/).length).toBe(1);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('mobile: close button visible without hover and guarded by confirm', async ({
    page,
    request,
  }) => {
    const sessionName = `tmex-e2e-close-m-${Date.now()}`;
    const { paneIds, windowIds } = createTwoWindowSession(sessionName);

    const createRes = await request.post('/api/devices', {
      data: {
        name: `e2e-close-mobile-${Date.now()}`,
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
        `/devices/${deviceId}/windows/${windowIds[0]}/panes/${encodeURIComponent(paneIds[0])}`
      );
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });

      await page.getByTestId('mobile-sidebar-open').click();
      const sidebar = page.getByTestId('sidebar');
      await expect(sidebar).toBeVisible();

      // 非选中窗口的关闭按钮在触屏上无需 hover 即可见
      const closeButton = page.getByTestId(`window-close-${windowIds[1]}`);
      await expect(closeButton).toBeVisible();
      await expect
        .poll(() => closeButton.evaluate((el) => getComputedStyle(el).opacity))
        .toBe('1');

      // 点击不再直接关闭，而是弹确认对话框
      await closeButton.click();
      const dialog = page.locator('[data-slot="alert-dialog-content"]');
      await expect(dialog).toBeVisible();
      await dialog.locator('[data-slot="alert-dialog-cancel"]').click();
      await expect(dialog).toBeHidden();
      expect(tmux(`list-windows -t ${sessionName} -F '#{window_id}'`).split(/\r?\n/).length).toBe(
        2
      );

      await closeButton.click();
      await expect(dialog).toBeVisible();
      await dialog.locator('[data-slot="alert-dialog-action"]').click();
      await expect(page.getByTestId(`window-item-${windowIds[1]}`)).toHaveCount(0, {
        timeout: 20_000,
      });
      expect(tmux(`list-windows -t ${sessionName} -F '#{window_id}'`).split(/\r?\n/).length).toBe(
        1
      );
    } finally {
      await request.delete(`/api/devices/${deviceId}`);
      ensureCleanSession(sessionName);
    }
  });
});
