import { devices, expect, test } from '@playwright/test';
import { createTwoPaneSession, ensureCleanSession } from './helpers/tmux';
import { KIND, decodeEnvelope } from './helpers/ws-borsh';

// Android 形态：非 iOS UA + 触屏，needsManualKeyboardAvoidance 才会启用避让
test.use({ ...devices['Pixel 5'] });

// Playwright 无法真正弹出虚拟键盘，用可控的 visualViewport mock 模拟
// Android Chrome resizes-visual 行为：键盘弹出仅缩小 visual viewport。
const VISUAL_VIEWPORT_MOCK = `
  (() => {
    class MockVisualViewport extends EventTarget {
      constructor() {
        super();
        this.keyboardHeight = 0;
      }
      get width() { return window.innerWidth; }
      get height() { return window.innerHeight - this.keyboardHeight; }
      get offsetTop() { return 0; }
      get offsetLeft() { return 0; }
      get pageTop() { return 0; }
      get pageLeft() { return 0; }
      get scale() { return 1; }
    }
    const mock = new MockVisualViewport();
    window.__tmexMockKeyboard = (px) => {
      mock.keyboardHeight = px;
      mock.dispatchEvent(new Event('resize'));
    };
    Object.defineProperty(window, 'visualViewport', { value: mock, configurable: true });
  })();
`;

test('mobile: Android keyboard occlusion is avoided by translate without any resize', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-kb-avoid-${Date.now()}`;
  createTwoPaneSession(sessionName);

  const name = `e2e-kb-avoid-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  let resizeFrames = 0;
  page.on('websocket', (ws) => {
    if (!ws.url().endsWith('/ws')) return;
    ws.on('framesent', ({ payload }) => {
      const envelope = decodeEnvelope(payload as Buffer);
      if (!envelope) return;
      if (envelope.kind === KIND.TERM_RESIZE || envelope.kind === KIND.TERM_SYNC_SIZE) {
        resizeFrames += 1;
      }
    });
  });

  await page.addInitScript(VISUAL_VIEWPORT_MOCK);

  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.getByTestId('terminal-shortcuts-strip')).toBeVisible();

    // 显式声明 resizes-visual，键盘弹收不得改变 layout viewport
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
      'content',
      /interactive-widget=resizes-visual/
    );

    const inset = page.locator('main[data-slot="sidebar-inset"]');
    const terminalHost = page.locator('[data-virtual-keyboard-avoid]').first();
    await expect(terminalHost).toBeVisible();

    const readState = () =>
      page.evaluate(() => {
        const insetEl = document.querySelector('main[data-slot="sidebar-inset"]');
        const hostEl = document.querySelector('[data-virtual-keyboard-avoid]');
        return {
          transform: insetEl ? getComputedStyle(insetEl).transform : null,
          hostHeight: hostEl ? (hostEl as HTMLElement).offsetHeight : null,
        };
      });

    // 等初始 resize 收敛后再开始计数
    await page.waitForTimeout(800);
    const before = await readState();
    expect(before.transform).toBe('none');
    expect(before.hostHeight).toBeGreaterThan(0);
    resizeFrames = 0;

    // 聚焦终端（direct 模式，焦点落在 ghostty 的 contenteditable 输入元素上）
    const ghosttyInput = page
      .locator('[data-virtual-keyboard-avoid] .xterm-helper-textarea')
      .first();
    await expect(ghosttyInput).toBeAttached();
    await ghosttyInput.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }));
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(document.activeElement?.closest('[data-virtual-keyboard-avoid]'))
        )
      )
      .toBe(true);

    // 键盘弹出 → 布局整体上移键盘高度
    await page.evaluate(() => {
      (window as unknown as { __tmexMockKeyboard: (px: number) => void }).__tmexMockKeyboard(320);
    });
    await expect.poll(async () => (await readState()).transform).toBe('matrix(1, 0, 0, 1, 0, -320)');

    // 终端容器尺寸必须纹丝不动，且没有任何 resize/sync 帧发出
    await page.waitForTimeout(600);
    const during = await readState();
    expect(during.hostHeight).toBe(before.hostHeight);
    expect(resizeFrames).toBe(0);

    // 键盘收起 → 复位为无 transform
    await page.evaluate(() => {
      (window as unknown as { __tmexMockKeyboard: (px: number) => void }).__tmexMockKeyboard(0);
    });
    await expect.poll(async () => (await readState()).transform).toBe('none');

    // 焦点不在避让容器内时，键盘弹出不平移（如系统级输入场景）
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      (window as unknown as { __tmexMockKeyboard: (px: number) => void }).__tmexMockKeyboard(320);
    });
    await page.waitForTimeout(300);
    expect((await readState()).transform).toBe('none');
    expect(resizeFrames).toBe(0);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
