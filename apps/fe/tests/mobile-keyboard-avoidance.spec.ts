import { type APIRequestContext, type Page, devices, expect, test } from '@playwright/test';
import type { KeyboardBehaviorMode } from '../src/stores/ui';
import { createSinglePaneSession, ensureCleanSession } from './helpers/tmux';
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

interface KeyboardTestContext {
  deviceId: string;
  sessionName: string;
  resizeFrames: () => number;
  resetResizeFrames: () => void;
  readState: () => Promise<{ transform: string | null; mainHeight: number; hostHeight: number }>;
  focusTerminal: () => Promise<void>;
  popKeyboard: (px: number) => Promise<void>;
}

// 启动设备页并预置键盘行为模式（写 zustand persist 的 localStorage，hydrate 前生效）。
async function bootstrap(
  page: Page,
  request: APIRequestContext,
  mode: KeyboardBehaviorMode
): Promise<KeyboardTestContext> {
  const sessionName = `tmex-e2e-kb-${mode}-${Date.now()}`;
  createSinglePaneSession(sessionName);

  const name = `e2e-kb-${mode}-${Date.now()}`;
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
  await page.addInitScript((behaviorMode) => {
    try {
      const raw = localStorage.getItem('tmex-ui');
      const parsed = raw ? JSON.parse(raw) : { state: {}, version: 0 };
      parsed.state = { ...(parsed.state ?? {}), keyboardBehaviorMode: behaviorMode };
      localStorage.setItem('tmex-ui', JSON.stringify(parsed));
    } catch {
      /* ignore */
    }
  }, mode);

  await page.goto(`/devices/${deviceId}`);
  await expect(page.getByTestId('device-page')).toBeVisible();
  await expect(page.getByTestId('terminal-shortcuts-strip')).toBeVisible();

  const readState = () =>
    page.evaluate(() => {
      const insetEl = document.querySelector('main[data-slot="sidebar-inset"]');
      const hostEl = document.querySelector('[data-virtual-keyboard-avoid]');
      return {
        transform: insetEl ? getComputedStyle(insetEl).transform : null,
        mainHeight: insetEl ? (insetEl as HTMLElement).offsetHeight : 0,
        hostHeight: hostEl ? (hostEl as HTMLElement).offsetHeight : 0,
      };
    });

  const focusTerminal = async () => {
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
  };

  const popKeyboard = async (px: number) => {
    await page.evaluate((value) => {
      (window as unknown as { __tmexMockKeyboard: (px: number) => void }).__tmexMockKeyboard(value);
    }, px);
  };

  return {
    deviceId,
    sessionName,
    resizeFrames: () => resizeFrames,
    resetResizeFrames: () => {
      resizeFrames = 0;
    },
    readState,
    focusTerminal,
    popKeyboard,
  };
}

function parseTranslateY(transform: string | null): number {
  if (!transform || transform === 'none') return 0;
  const match = transform.match(/matrix\(([^)]+)\)/);
  if (!match) return 0;
  const parts = match[1].split(',').map((v) => Number.parseFloat(v.trim()));
  return parts.length >= 6 ? parts[5] : 0;
}

// 模式「页面平移」(lift)：键盘弹出整页上移键盘高度，终端尺寸不变、无 resize 帧——0.12.0 现状契约
test('mobile keyboard mode "lift": translate by keyboard height, no resize', async ({
  page,
  request,
}) => {
  const ctx = await bootstrap(page, request, 'lift');
  try {
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
      'content',
      /interactive-widget=resizes-visual/
    );

    await page.waitForTimeout(800);
    const before = await ctx.readState();
    expect(before.transform).toBe('none');
    expect(before.hostHeight).toBeGreaterThan(0);
    ctx.resetResizeFrames();

    await ctx.focusTerminal();
    await ctx.popKeyboard(320);
    await expect
      .poll(async () => (await ctx.readState()).transform)
      .toBe('matrix(1, 0, 0, 1, 0, -320)');

    await page.waitForTimeout(600);
    const during = await ctx.readState();
    expect(during.hostHeight).toBe(before.hostHeight);
    expect(ctx.resizeFrames()).toBe(0);

    await ctx.popKeyboard(0);
    await expect.poll(async () => (await ctx.readState()).transform).toBe('none');

    // 焦点不在避让容器内时键盘弹出不平移
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await ctx.popKeyboard(320);
    await page.waitForTimeout(300);
    expect((await ctx.readState()).transform).toBe('none');
    expect(ctx.resizeFrames()).toBe(0);
  } finally {
    await request.delete(`/api/devices/${ctx.deviceId}`);
    ensureCleanSession(ctx.sessionName);
  }
});

// 模式「光标对齐」(follow)：空 shell 光标在顶部时，键盘弹出几乎不上移，光标保持可见——issue #27 核心修复
test('mobile keyboard mode "follow": empty shell keeps cursor visible without full lift', async ({
  page,
  request,
}) => {
  const ctx = await bootstrap(page, request, 'follow');
  try {
    await page.waitForTimeout(800);
    const before = await ctx.readState();
    expect(before.transform).toBe('none');
    ctx.resetResizeFrames();

    await ctx.focusTerminal();
    await ctx.popKeyboard(320);
    // 新 shell 光标在顶部：follow 上移量远小于键盘高度（修复「看不见输入」），绝不满抬 320
    await page.waitForTimeout(400);
    const during = await ctx.readState();
    const lift = Math.abs(parseTranslateY(during.transform));
    expect(lift).toBeLessThan(120);
    // 不改终端尺寸、不触发 resize
    expect(during.hostHeight).toBe(before.hostHeight);
    expect(ctx.resizeFrames()).toBe(0);

    // 快捷键栏浮到键盘正上方：底沿贴近键盘顶（innerHeight - 320），而非被键盘盖在底部
    const bar = await page.evaluate(() => {
      const el = document.querySelector('.terminal-shortcuts-strip');
      return {
        bottom: el ? el.getBoundingClientRect().bottom : null,
        keyboardTop: window.innerHeight - 320,
        innerHeight: window.innerHeight,
      };
    });
    expect(bar.bottom).not.toBeNull();
    if (bar.bottom !== null) {
      // 浮到键盘顶附近（含终端 padding 容差），且明显高于「被键盘盖住」的视口底
      expect(Math.abs(bar.bottom - bar.keyboardTop)).toBeLessThan(48);
      expect(bar.bottom).toBeLessThan(bar.innerHeight - 240);
    }
    await page.screenshot({ path: '/tmp/kb-follow-shortcuts.png' });

    await ctx.popKeyboard(0);
    await expect.poll(async () => (await ctx.readState()).transform).toBe('none');
    // 键盘收起后浮动复位（RAF 收敛后归 0）
    await expect
      .poll(async () =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue('--tmex-kb-shortcut-lift')
            .trim()
        )
      )
      .toMatch(/^(0px)?$/);
  } finally {
    await request.delete(`/api/devices/${ctx.deviceId}`);
    ensureCleanSession(ctx.sessionName);
  }
});

// 模式「终端缩放」(resize)：键盘弹出不平移，改为收缩可用高度并触发终端 resize
test('mobile keyboard mode "resize": shrink available height and resize terminal', async ({
  page,
  request,
}) => {
  const ctx = await bootstrap(page, request, 'resize');
  try {
    await page.waitForTimeout(800);
    const before = await ctx.readState();
    expect(before.transform).toBe('none');
    expect(before.mainHeight).toBeGreaterThan(0);
    ctx.resetResizeFrames();

    await ctx.focusTerminal();
    await ctx.popKeyboard(320);
    // 不用 transform，改用 height：<main> 高度收缩到键盘上方可用高度
    await expect.poll(async () => (await ctx.readState()).transform).toBe('none');
    await expect
      .poll(async () => (await ctx.readState()).mainHeight)
      .toBeLessThan(before.mainHeight - 200);
    // 容器收缩触发终端 resize
    await expect.poll(() => ctx.resizeFrames()).toBeGreaterThan(0);

    // 键盘过高（可用高度 < 60）时退化为整页上移，终端不被压没（issue #27 修复）
    await ctx.popKeyboard(700);
    await page.waitForTimeout(400);
    const huge = await page.evaluate(() => {
      const main = document.querySelector('main[data-slot="sidebar-inset"]');
      const canvas = document.querySelector('[data-terminal-engine] > div');
      return {
        transform: main ? getComputedStyle(main).transform : null,
        canvasHeight: canvas ? Math.round(canvas.getBoundingClientRect().height) : 0,
      };
    });
    expect(huge.transform).not.toBe('none'); // 退化为 transform，不再用 height 压扁
    expect(huge.canvasHeight).toBeGreaterThan(200); // 终端 canvas 不坍缩

    await ctx.popKeyboard(0);
    await expect.poll(async () => (await ctx.readState()).mainHeight).toBe(before.mainHeight);
  } finally {
    await request.delete(`/api/devices/${ctx.deviceId}`);
    ensureCleanSession(ctx.sessionName);
  }
});

// 光标靠近终端底部时，浮动快捷键栏底沿应精确贴键盘顶（修复前漏算终端 padding 会高出约
// 12px，导致光标被快捷键栏遮挡）——issue #27 迭代
test('mobile keyboard mode "follow": floating shortcut bar sits exactly at keyboard top', async ({
  page,
  request,
}) => {
  const ctx = await bootstrap(page, request, 'follow');
  try {
    await ctx.focusTerminal();
    // 输出不超过 viewport 的内容，把光标推到 viewport 内底部（cursor.y 有值）
    await page.keyboard.type('for i in $(seq 1 20); do echo "L$i ===="; done\n');
    await page.waitForTimeout(2500);
    await ctx.focusTerminal();
    await ctx.popKeyboard(320);
    await page.waitForTimeout(700);
    const { stripBottom, keyboardTop } = await page.evaluate(() => {
      const strip = document.querySelector('.terminal-shortcuts-strip');
      const sr = strip?.getBoundingClientRect();
      return {
        stripBottom: sr ? Math.round(sr.bottom) : null,
        keyboardTop: window.innerHeight - 320,
      };
    });
    // 快捷键栏底沿精确贴键盘顶（光标停其上方由 computeCursorFollowOffset 的 margin 单测保证）
    expect(stripBottom).not.toBeNull();
    if (stripBottom !== null) {
      expect(Math.abs(stripBottom - keyboardTop)).toBeLessThanOrEqual(3);
    }
  } finally {
    await request.delete(`/api/devices/${ctx.deviceId}`);
    ensureCleanSession(ctx.sessionName);
  }
});
