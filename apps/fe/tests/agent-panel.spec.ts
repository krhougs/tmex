// Agent 已从右侧独立 Panel 迁移到左 Sidebar 的一个 Tab。
// 本 spec 覆盖：三 Tab 切换、Agent tab 渲染、以及 sidebarTab 选择持久化（刷新保持）。

import { expect, test } from '@playwright/test';

test('agent sidebar tab: switch tabs and persist selection', async ({ page }) => {
  await page.goto('/');

  const panesTab = page.getByTestId('sidebar-tab-panes');
  const agentTab = page.getByTestId('sidebar-tab-agent');
  const filesTab = page.getByTestId('sidebar-tab-files');

  // 桌面端 sidebar 默认展开，三 Tab 可见，默认停在 Panes（agent-tab 未渲染）
  await expect(panesTab).toBeVisible();
  await expect(agentTab).toBeVisible();
  await expect(filesTab).toBeVisible();
  await expect(page.getByTestId('agent-tab')).toHaveCount(0);

  // 切到 Agent Tab：agent-tab 渲染，输入区可见
  await agentTab.click();
  await expect(page.getByTestId('agent-tab')).toBeVisible();
  await expect(page.getByTestId('agent-chat-input-textarea')).toBeVisible();

  // 无路由 pane 时无 session/草稿，输入禁用（空态提示）
  await expect(page.getByTestId('agent-chat-input-textarea')).toBeDisabled();
  await expect(page.getByTestId('agent-chat-send')).toBeDisabled();

  // 刷新后选择持久化（tmex-ui localStorage），仍停在 Agent Tab
  await page.reload();
  await expect(page.getByTestId('agent-tab')).toBeVisible();

  // 切回 Panes Tab：agent-tab 卸载，设备列表区渲染
  await page.getByTestId('sidebar-tab-panes').click();
  await expect(page.getByTestId('agent-tab')).toHaveCount(0);
});
