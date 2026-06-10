import { type Page, expect, test } from '@playwright/test';
import { createTwoPaneSession, ensureCleanSession } from './helpers/tmux';

async function activeElementClass(page: Page): Promise<string> {
  return page.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? '');
}

test('terminal regains focus on load, pane switch, mode toggle and refresh', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-focus-${Date.now()}`;
  const { paneIds, windowId } = createTwoPaneSession(sessionName);
  expect(paneIds.length >= 2).toBeTruthy();

  const name = `e2e-focus-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  try {
    // 初始加载后焦点应在终端
    await page.goto(
      `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneIds[0])}`
    );
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => activeElementClass(page), { timeout: 10_000 })
      .toContain('xterm-helper-textarea');

    // 通过 sidebar 切换 pane 后焦点应回到终端
    await page.getByTestId(`pane-item-${paneIds[1]}`).click();
    await expect
      .poll(() => page.evaluate(() => window.location.pathname), { timeout: 20_000 })
      .toContain(encodeURIComponent(paneIds[1]));
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => activeElementClass(page), { timeout: 10_000 })
      .toContain('xterm-helper-textarea');

    // editor 模式切回 direct 后焦点应回到终端
    await page.getByTestId('terminal-input-mode-toggle').click();
    await expect(page.getByTestId('editor-input')).toBeVisible();
    await page.getByTestId('terminal-input-mode-toggle').click();
    await expect
      .poll(() => activeElementClass(page), { timeout: 10_000 })
      .toContain('xterm-helper-textarea');

    // 页面刷新后焦点应回到终端
    await page.reload();
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => activeElementClass(page), { timeout: 10_000 })
      .toContain('xterm-helper-textarea');
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
