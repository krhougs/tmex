// Watch 规则前端 e2e：真后端（e2e 基建起的 gateway + 本机 tmux）。
// 覆盖：dialog 打开/创建 match 规则/角标/启停/删除；assist-regex 用 page.route mock
// 回填表单；真实链路触发 WATCH_EVENT toast（规则采样间隔 5s，echo token 后等待广播）。

import { expect, test } from '@playwright/test';
import { ensureCleanSession, tmux } from './helpers/tmux';

test.describe.serial('watch rules', () => {
  let deviceId: string;
  let windowId: string;
  let paneId: string;
  const sessionName = `tmex-e2e-watch-${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    ensureCleanSession(sessionName);
    tmux(`new-session -d -s ${sessionName} "sh -lc 'echo WATCH_PANE_READY; exec sh'"`);
    paneId = tmux(`list-panes -t ${sessionName}:0 -F '#{pane_id}'`).trim();
    windowId = tmux(`display-message -p -t ${sessionName}:0 '#{window_id}'`).trim();

    const deviceRes = await request.post('/api/devices', {
      data: {
        name: `e2e-watch-${Date.now()}`,
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
      // 先逐个删规则让 watch service 热卸载调度，再删设备
      const rulesRes = await request
        .get(`/api/watch/rules?deviceId=${deviceId}`)
        .catch(() => null);
      if (rulesRes?.ok()) {
        const payload = (await rulesRes.json()) as { rules: Array<{ id: string }> };
        for (const rule of payload.rules) {
          await request.delete(`/api/watch/rules/${rule.id}`).catch(() => undefined);
        }
      }
      await request.delete(`/api/devices/${deviceId}`).catch(() => undefined);
    }
    ensureCleanSession(sessionName);
  });

  async function openPaneAndDialog(page: import('@playwright/test').Page): Promise<void> {
    await page.goto(
      `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`
    );
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('watch-open-button').click();
    await expect(page.getByTestId('watch-dialog')).toBeVisible();
  }

  test('create match rule, toggle and delete via dialog', async ({ page }) => {
    await openPaneAndDialog(page);
    await expect(page.getByTestId('watch-rules-empty')).toBeVisible();

    // 新建 match 规则（pattern 直填）
    await page.getByTestId('watch-rule-add').click();
    await expect(page.getByTestId('watch-rule-form')).toBeVisible();
    await page.getByTestId('watch-form-name').fill('e2e match rule');
    await page.getByTestId('watch-form-pattern').fill('E2E_NEVER_MATCHES_(\\d+)');
    await page.getByTestId('watch-form-save').click();

    const ruleItem = page.locator(
      '[data-testid^="watch-rule-item-"][data-rule-name="e2e match rule"]'
    );
    await expect(ruleItem).toBeVisible();

    // 有启用规则时 PageActions 按钮带角标
    await expect(page.getByTestId('watch-active-indicator')).toBeVisible();

    // 启停 Switch（PATCH enabled）
    const toggle = ruleItem.locator('[data-testid^="watch-rule-toggle-"]');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('watch-active-indicator')).toHaveCount(0);

    // 删除（AlertDialog 确认）
    await ruleItem.locator('[data-testid^="watch-rule-delete-"]').click();
    await expect(page.getByTestId('watch-rule-delete-dialog')).toBeVisible();
    await page.getByTestId('watch-rule-delete-confirm').click();
    await expect(page.getByTestId('watch-rules-empty')).toBeVisible();
  });

  test('assist-regex fills pattern/flags and shows explanation/preview (mocked)', async ({
    page,
  }) => {
    await page.route('**/api/watch/assist-regex', async (route) => {
      await route.fulfill({
        json: {
          pattern: 'DL (\\d+)%',
          flags: 'i',
          extractGroup: 1,
          explanation: 'Matches download percentage',
          preview: ['DL 42%', 'DL 73%'],
        },
      });
    });

    await openPaneAndDialog(page);
    await page.getByTestId('watch-rule-add').click();
    await expect(page.getByTestId('watch-rule-form')).toBeVisible();

    await page.getByTestId('watch-form-assist-input').fill('match download percentage');
    await page.getByTestId('watch-form-assist-generate').click();

    await expect(page.getByTestId('watch-form-pattern')).toHaveValue('DL (\\d+)%');
    await expect(page.getByTestId('watch-form-flags')).toHaveValue('i');
    const assistResult = page.getByTestId('watch-form-assist-result');
    await expect(assistResult).toContainText('Matches download percentage');
    await expect(assistResult).toContainText('DL 42%');
    await expect(assistResult).toContainText('DL 73%');
  });

  test('triggered rule shows toast with rule name (real backend)', async ({ page, request }) => {
    const ruleName = `e2e-trigger-${Date.now()}`;
    const token = `E2E_WATCH_TOKEN_${Date.now()}`;

    const createRes = await request.post('/api/watch/rules', {
      data: {
        name: ruleName,
        deviceId,
        paneId,
        triggerType: 'match',
        pattern: token,
        intervalSeconds: 5,
        fireMode: 'once',
      },
    });
    expect(createRes.ok()).toBeTruthy();

    // 打开页面建立 WS 连接（WATCH_EVENT 广播给所有客户端）
    await page.goto(
      `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`
    );
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });

    // 让 token 出现在屏幕上，等待 watch service 下一次采样命中并广播
    tmux(`send-keys -t ${paneId} "echo ${token}" Enter`);

    const toast = page.locator('[data-sonner-toast]').filter({ hasText: ruleName });
    await expect(toast).toBeVisible({ timeout: 30_000 });
  });
});
