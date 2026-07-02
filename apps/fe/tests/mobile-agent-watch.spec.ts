// 移动端视口 spot check：375x812 下 agent 现为左 Sidebar 的 Agent Tab，
// sidebar 以 Sheet 形态打开；进入 Agent Tab 后输入框可见可用。
// WatchDialog 可打开且表单可达。真后端 + 本机 tmux。

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

    test('agent tab opens in sidebar sheet with usable input', async ({ page }) => {
      await page.goto(
        `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`
      );
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });

      // 移动端：从顶栏打开 sidebar Sheet，再切到 Agent Tab
      await page.getByTestId('mobile-sidebar-open').click();
      await expect(page.getByTestId('mobile-sidebar-sheet')).toBeVisible();

      await page.getByTestId('sidebar-tab-agent').click();
      await expect(page.getByTestId('agent-tab')).toBeVisible();

      // 当前 pane 自动起草，输入框在视口内可见可用
      const textarea = page.getByTestId('agent-chat-input-textarea');
      await expect(textarea).toBeVisible();
      await expect(textarea).toBeInViewport();
      await expect(textarea).toBeEnabled();

      // 模型选择器可见（Agent Tab 头部）
      await expect(page.getByTestId('agent-model-picker')).toBeVisible();

      // 切回 Panes Tab：设备会话树可达
      await page.getByTestId('sidebar-tab-panes').click();
      await expect(page.getByTestId('agent-tab')).toHaveCount(0);

      // 关闭 Sheet 回到终端
      await page.getByTestId('mobile-sidebar-close').click();
      await expect(page.getByTestId('mobile-sidebar-sheet')).toHaveCount(0);
    });

    test('watch dialog opens and rule form is reachable', async ({ page }) => {
      await page.goto(
        `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`
      );
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });

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
