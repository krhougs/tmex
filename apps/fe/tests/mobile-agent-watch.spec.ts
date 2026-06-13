// 移动端视口 spot check：375x812 下 agent 面板以 Sheet 形态打开、
// 输入框可见可用；WatchDialog 可打开且表单可达。真后端 + 本机 tmux。

import { expect, test } from '@playwright/test';
import { ensureCleanSession, tmux } from './helpers/tmux';

test.use({ viewport: { width: 375, height: 812 } });

test.describe
  .serial('mobile: agent panel and watch dialog', () => {
    let deviceId: string;
    let windowId: string;
    let paneId: string;
    const sessionName = `tmex-e2e-mobile-aw-${Date.now()}`;

    test.beforeAll(async ({ request }) => {
      ensureCleanSession(sessionName);
      tmux(`new-session -d -s ${sessionName} "sh -lc 'echo MOBILE_PANE_READY; exec sh'"`);
      paneId = tmux(`list-panes -t ${sessionName}:0 -F '#{pane_id}'`).trim();
      windowId = tmux(`display-message -p -t ${sessionName}:0 '#{window_id}'`).trim();

      const deviceRes = await request.post('/api/devices', {
        data: {
          name: `e2e-mobile-aw-${Date.now()}`,
          type: 'local',
          session: sessionName,
          authMode: 'auto',
        },
      });
      expect(deviceRes.ok()).toBeTruthy();
      const created = (await deviceRes.json()) as { device: { id: string } };
      deviceId = created.device.id;
    });

    test.afterAll(async ({ request }) => {
      if (deviceId) {
        await request.delete(`/api/devices/${deviceId}`).catch(() => undefined);
      }
      ensureCleanSession(sessionName);
    });

    test('agent panel opens as full-screen sheet with usable input', async ({ page }) => {
      await page.goto(
        `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`
      );
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });

      await page.getByTestId('right-panel-trigger').first().click();
      await expect(page.getByTestId('mobile-right-panel-sheet')).toBeVisible();
      await expect(page.getByTestId('agent-panel')).toBeVisible();

      // 输入框在视口内可见可用（session 未创建时也应渲染输入区骨架或提示）
      const textarea = page.getByTestId('agent-chat-input-textarea');
      await expect(textarea).toBeVisible();
      await expect(textarea).toBeInViewport();

      // session 切换器可用（菜单能弹出）
      await page.getByTestId('agent-session-switcher').click();
      await expect(page.getByTestId('agent-session-switcher-menu')).toBeVisible();
      await page.keyboard.press('Escape');

      // 关闭 Sheet 回到终端
      await page.getByTestId('right-panel-close').click();
      await expect(page.getByTestId('mobile-right-panel-sheet')).toHaveCount(0);
    });

    test('watch dialog opens and rule form is reachable', async ({ page }) => {
      await page.goto(
        `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`
      );
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });

      await page.getByTestId('watch-open-button').click();
      await expect(page.getByTestId('watch-dialog')).toBeVisible();

      await page.getByTestId('watch-rule-add').click();
      await expect(page.getByTestId('watch-rule-form')).toBeVisible();
      await expect(page.getByTestId('watch-form-name')).toBeInViewport();
      await page.getByTestId('watch-form-name').fill('mobile spot check');
      await expect(page.getByTestId('watch-form-pattern')).toBeVisible();

      // 保存按钮可达：表单长于视口，dialog 内容可滚动到底部的保存按钮
      await page.getByTestId('watch-form-save').scrollIntoViewIfNeeded();
      await expect(page.getByTestId('watch-form-save')).toBeInViewport();
    });
  });
