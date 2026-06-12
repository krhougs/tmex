import { expect, test } from '@playwright/test';

test('agent panel: toggle, resize and persistence', async ({ page }) => {
  await page.goto('/');

  const panelRoot = page.locator('[data-slot="right-panel"]');
  const trigger = page.getByTestId('right-panel-trigger');
  await expect(trigger).toBeVisible();

  // 默认收起
  await expect(panelRoot).toHaveAttribute('data-state', 'collapsed');

  // 点击 trigger 展开，骨架内容可见
  await trigger.click();
  await expect(panelRoot).toHaveAttribute('data-state', 'expanded');
  const agentPanel = page.getByTestId('agent-panel');
  await expect(agentPanel).toBeVisible();
  await expect(page.getByTestId('agent-chat-thread')).toBeVisible();
  await expect(page.getByTestId('agent-chat-input-textarea')).toBeDisabled();
  await expect(page.getByTestId('agent-chat-send')).toBeDisabled();

  // 拖拽 resizer 向左 100px 增宽
  const inner = page.getByTestId('right-panel');
  const before = await inner.boundingBox();
  expect(before).not.toBeNull();
  if (!before) throw new Error('panel boundingBox missing');

  const resizer = page.getByTestId('right-panel-resizer');
  const resizerBox = await resizer.boundingBox();
  expect(resizerBox).not.toBeNull();
  if (!resizerBox) throw new Error('resizer boundingBox missing');

  const startX = resizerBox.x + resizerBox.width / 2;
  const startY = resizerBox.y + resizerBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 100, startY, { steps: 5 });
  await page.mouse.up();

  const after = await inner.boundingBox();
  if (!after) throw new Error('panel boundingBox missing after resize');
  expect(Math.round(after.width)).toBe(Math.round(before.width) + 100);

  // 刷新后展开态与宽度保持
  await page.reload();
  await expect(panelRoot).toHaveAttribute('data-state', 'expanded');
  const reloaded = await page.getByTestId('right-panel').boundingBox();
  if (!reloaded) throw new Error('panel boundingBox missing after reload');
  expect(Math.round(reloaded.width)).toBe(Math.round(after.width));

  // 面板内关闭按钮收起
  await page.getByTestId('right-panel-close').click();
  await expect(panelRoot).toHaveAttribute('data-state', 'collapsed');

  // Ctrl+J 快捷键再次展开
  await page.keyboard.press('Control+j');
  await expect(panelRoot).toHaveAttribute('data-state', 'expanded');
});
