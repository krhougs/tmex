import { expect, test } from '@playwright/test';
import { createTwoPaneSession, ensureCleanSession } from './helpers/tmux';

// 终端自定义快捷键编辑器：默认列表 / 实时预览 / 图标开关（苹果符号）/ 添加动作 / 保存生效。
test.use({ viewport: { width: 1024, height: 900 } });

test('terminal custom shortcuts: preview, icon toggle, add action, save persists', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-sc-${Date.now()}`;
  createTwoPaneSession(sessionName);
  const name = `e2e-sc-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const { device } = (await createRes.json()) as { device: { id: string } };

  try {
    await page.goto(`/devices/${device.id}`);
    await expect(page.getByTestId('device-page')).toBeVisible();

    // 打开终端设置 Sheet（内含快捷键编辑器）
    await page.getByTestId('keyboard-behavior-open-button').click();
    await expect(page.getByTestId('keyboard-behavior-sheet')).toBeVisible();

    const editor = page.getByTestId('terminal-shortcuts-editor');
    await editor.scrollIntoViewIfNeeded();
    await expect(editor).toBeVisible();

    // 默认 12 项
    const list = page.getByTestId('shortcut-editor-list');
    await expect(list.locator('[data-testid^="shortcut-editor-row-"]')).toHaveCount(12);

    // 预览：文字模式 CTRL-C
    const preview = page.getByTestId('shortcut-preview');
    const previewCtrlC = preview.getByTestId('editor-shortcut-ctrl-c');
    await expect(previewCtrlC).toHaveText('CTRL-C');
    // action 按钮（paste）渲染为图标
    await expect(preview.getByTestId('editor-shortcut-paste').locator('svg')).toBeVisible();

    await editor.scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/sc-text-mode.png' });

    // 切图标模式：send 类按键名 → 苹果符号
    await page.getByTestId('shortcut-use-icons').click();
    await expect(previewCtrlC).toHaveText('⌃C');
    await expect(preview.getByTestId('editor-shortcut-shift-enter')).toHaveText('⇧⏎');
    await expect(preview.getByTestId('editor-shortcut-shift-tab')).toHaveText('⇧⇥');
    await expect(preview.getByTestId('editor-shortcut-backspace')).toHaveText('⌫');
    await expect(preview.getByTestId('editor-shortcut-esc')).toHaveText('⎋');

    await editor.scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/sc-icon-mode.png' });

    // 添加特殊动作：终端回到最下方
    await page.getByTestId('shortcut-add-action-scrollToBottom').click();
    await expect(list.locator('[data-testid^="shortcut-editor-row-"]')).toHaveCount(13);

    // 保存
    await page.getByTestId('shortcut-save').click();

    // 服务器读回：13 项 + useIcons 持久化
    await expect
      .poll(async () => {
        const res = await request.get('/api/settings/terminal-shortcuts');
        const json = (await res.json()) as { settings: { items: unknown[] } };
        return json.settings.items.length;
      })
      .toBe(13);
    const finalJson = (await (await request.get('/api/settings/terminal-shortcuts')).json()) as {
      settings: { useIcons: boolean };
    };
    expect(finalJson.settings.useIcons).toBe(true);
  } finally {
    await request.delete(`/api/devices/${device.id}`);
    ensureCleanSession(sessionName);
  }
});
