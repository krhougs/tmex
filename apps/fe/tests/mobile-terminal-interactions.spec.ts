import { expect, test } from '@playwright/test';
import { KIND, decodeEnvelope, decodeTermInput } from './helpers/ws-borsh';
import { createTwoPaneSession, ensureCleanSession, tmux } from './helpers/tmux';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function swipe(
  page: Parameters<typeof test>[0]['page'],
  selector: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 8
): Promise<void> {
  await page.evaluate(
    ({ selector, from, to, steps }) => {
      const target = document.querySelector(selector);
      if (!(target instanceof HTMLElement)) {
        throw new Error(`target not found: ${selector}`);
      }
      if (typeof Touch === 'undefined' || typeof TouchEvent === 'undefined') {
        throw new Error('touch event API not available');
      }

      const createTouch = (x: number, y: number) =>
        new Touch({
          identifier: 1,
          target,
          clientX: x,
          clientY: y,
          pageX: x,
          pageY: y,
          radiusX: 1,
          radiusY: 1,
          rotationAngle: 0,
          force: 1,
        });

      const startTouch = createTouch(from.x, from.y);
      target.dispatchEvent(
        new TouchEvent('touchstart', {
          bubbles: true,
          cancelable: true,
          touches: [startTouch],
          targetTouches: [startTouch],
          changedTouches: [startTouch],
        })
      );

      let currentTouch = startTouch;
      for (let i = 1; i <= steps; i += 1) {
        const ratio = i / steps;
        const touch = createTouch(from.x + (to.x - from.x) * ratio, from.y + (to.y - from.y) * ratio);
        currentTouch = touch;
        target.dispatchEvent(
          new TouchEvent('touchmove', {
            bubbles: true,
            cancelable: true,
            touches: [touch],
            targetTouches: [touch],
            changedTouches: [touch],
          })
        );
      }

      target.dispatchEvent(
        new TouchEvent('touchend', {
          bubbles: true,
          cancelable: true,
          touches: [],
          targetTouches: [],
          changedTouches: [currentTouch],
        })
      );
    },
    { selector, from, to, steps }
  );
}

test('mobile: editor interactions keep focus and send ws messages', async ({ page, request }) => {
  const sessionName = `tmex-e2e-mobile-${Date.now()}`;
  createTwoPaneSession(sessionName);

  const name = `e2e-mobile-term-${Date.now()}`;

  const createRes = await request.post('/api/devices', {
    data: {
      name,
      type: 'local',
      session: sessionName,
      authMode: 'auto',
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  const sentInputs: Array<{ deviceId: string; data: string }> = [];

  page.on('websocket', (ws) => {
    if (!ws.url().endsWith('/ws')) return;
    ws.on('framesent', ({ payload }) => {
      const envelope = decodeEnvelope(payload as Buffer);
      if (!envelope || envelope.kind !== KIND.TERM_INPUT) return;
      const decoded = decodeTermInput(envelope.payload);
      sentInputs.push({ deviceId: decoded.deviceId, data: decoded.data.toString('utf8') });
    });
  });

  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.getByTestId('mobile-topbar')).toBeVisible();

    await expect(page.getByTestId('editor-shortcut-ctrl-c')).toBeEnabled({ timeout: 20_000 });

    await page.getByTestId('terminal-input-mode-toggle').click();
    const editorInput = page.getByTestId('editor-input');
    await expect(editorInput).toBeVisible();
    await editorInput.fill('echo hello');
    await expect(editorInput).toBeFocused();

    await page.getByTestId('editor-shortcut-ctrl-c').click();
    await expect(editorInput).toBeFocused();
    await expect.poll(() => {
      return sentInputs.some((msg) => msg.deviceId === deviceId && msg.data === '\u0003');
    }).toBeTruthy();

    await page.getByTestId('editor-send').click();
    await expect(editorInput).toBeFocused();
    await expect(editorInput).toHaveValue('');
    await expect.poll(() => {
      return sentInputs.some((msg) => msg.deviceId === deviceId && msg.data === 'echo hello\r');
    }).toBeTruthy();
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('mobile: direct input falls back to compositionend data for ime symbols', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-mobile-ime-symbol-${Date.now()}`;
  createTwoPaneSession(sessionName);

  const name = `e2e-mobile-ime-symbol-${Date.now()}`;

  const createRes = await request.post('/api/devices', {
    data: {
      name,
      type: 'local',
      session: sessionName,
      authMode: 'auto',
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  const sentInputs: Array<{ deviceId: string; data: string; isComposing: boolean }> = [];

  page.on('websocket', (ws) => {
    if (!ws.url().endsWith('/ws')) return;
    ws.on('framesent', ({ payload }) => {
      const envelope = decodeEnvelope(payload as Buffer);
      if (!envelope || envelope.kind !== KIND.TERM_INPUT) return;
      const decoded = decodeTermInput(envelope.payload);
      sentInputs.push({
        deviceId: decoded.deviceId,
        data: decoded.data.toString('utf8'),
        isComposing: decoded.isComposing,
      });
    });
  });

  try {
    await page.addInitScript(() => {
      (globalThis as any).__TMEX_E2E_DEBUG = true;
    });

    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.getByTestId('editor-shortcut-ctrl-c')).toBeEnabled({ timeout: 20_000 });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const g = globalThis as any;
          return Boolean(g.__tmexE2eXterm?.textarea);
        })
      )
      .toBeTruthy();

    await page.evaluate(() => {
      const g = globalThis as any;
      const term = g.__tmexE2eXterm;
      const textarea = term?.textarea as HTMLTextAreaElement | undefined;
      if (!term || !textarea) {
        throw new Error('xterm instance not ready');
      }

      textarea.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
      textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '；' }));
    });

    await expect
      .poll(() =>
        sentInputs.some(
          (msg) =>
            msg.deviceId === deviceId && msg.isComposing === false && msg.data.includes('；')
        )
      )
      .toBeTruthy();
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('mobile: cancelled ime composition should not send fallback text', async ({ page, request }) => {
  const sessionName = `tmex-e2e-mobile-ime-cancel-${Date.now()}`;
  createTwoPaneSession(sessionName);

  const name = `e2e-mobile-ime-cancel-${Date.now()}`;

  const createRes = await request.post('/api/devices', {
    data: {
      name,
      type: 'local',
      session: sessionName,
      authMode: 'auto',
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  const sentInputs: Array<{ deviceId: string; data: string; isComposing: boolean }> = [];

  page.on('websocket', (ws) => {
    if (!ws.url().endsWith('/ws')) return;
    ws.on('framesent', ({ payload }) => {
      const envelope = decodeEnvelope(payload as Buffer);
      if (!envelope || envelope.kind !== KIND.TERM_INPUT) return;
      const decoded = decodeTermInput(envelope.payload);
      sentInputs.push({
        deviceId: decoded.deviceId,
        data: decoded.data.toString('utf8'),
        isComposing: decoded.isComposing,
      });
    });
  });

  try {
    await page.addInitScript(() => {
      (globalThis as any).__TMEX_E2E_DEBUG = true;
    });

    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.getByTestId('editor-shortcut-ctrl-c')).toBeEnabled({ timeout: 20_000 });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const g = globalThis as any;
          return Boolean(g.__tmexE2eXterm?.textarea);
        })
      )
      .toBeTruthy();

    await page.evaluate(() => {
      const g = globalThis as any;
      const term = g.__tmexE2eXterm;
      const textarea = term?.textarea as HTMLTextAreaElement | undefined;
      if (!term || !textarea) {
        throw new Error('xterm instance not ready');
      }

      textarea.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
      textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'n' }));
      textarea.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          data: 'n',
          inputType: 'insertCompositionText',
        })
      );
      textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));
    });

    await page.waitForTimeout(250);
    const leakedChars = sentInputs.filter((msg) => msg.deviceId === deviceId && msg.data === 'n');
    expect(leakedChars).toHaveLength(0);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('mobile: paste text should be sent only once', async ({ page, request }) => {
  const sessionName = `tmex-e2e-mobile-paste-once-${Date.now()}`;
  createTwoPaneSession(sessionName);

  const name = `e2e-mobile-paste-once-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: {
      name,
      type: 'local',
      session: sessionName,
      authMode: 'auto',
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  const sentInputs: Array<{ deviceId: string; data: string; isComposing: boolean }> = [];

  page.on('websocket', (ws) => {
    if (!ws.url().endsWith('/ws')) return;
    ws.on('framesent', ({ payload }) => {
      const envelope = decodeEnvelope(payload as Buffer);
      if (!envelope || envelope.kind !== KIND.TERM_INPUT) return;
      const decoded = decodeTermInput(envelope.payload);
      sentInputs.push({
        deviceId: decoded.deviceId,
        data: decoded.data.toString('utf8'),
        isComposing: decoded.isComposing,
      });
    });
  });

  const pasteText = `__TMEX_PASTE_ONCE_${Date.now()}__`;

  try {
    await page.addInitScript(() => {
      (globalThis as any).__TMEX_E2E_DEBUG = true;
    });
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('mobile-topbar')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('device-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('editor-shortcut-ctrl-c')).toBeEnabled({ timeout: 20_000 });

    await page.evaluate(async (text) => {
      const g = globalThis as any;
      const term = g.__tmexE2eXterm;
      const textarea = term?.textarea as HTMLTextAreaElement | undefined;
      if (!term || !textarea) {
        throw new Error('xterm instance not ready');
      }

      textarea.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          data: text,
          inputType: 'insertFromPaste',
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 80));
      term.paste(text);
    }, pasteText);

    await expect
      .poll(
        () => sentInputs.filter((msg) => msg.deviceId === deviceId && msg.data.includes(pasteText)).length
      )
      .toBe(1);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('mobile: terminal can scroll with touch gesture', async ({ page, request }) => {
  const sessionName = `tmex-e2e-mobile-scroll-${Date.now()}`;
  createTwoPaneSession(sessionName);

  const name = `e2e-mobile-scroll-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: {
      name,
      type: 'local',
      session: sessionName,
      authMode: 'auto',
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  try {
    await page.addInitScript(() => {
      (globalThis as any).__TMEX_E2E_DEBUG = true;
    });
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('mobile-topbar')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('device-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('editor-shortcut-ctrl-c')).toBeEnabled({ timeout: 20_000 });

    tmux(
      `send-keys -t ${sessionName}.0 "for i in \\$(seq 1 320); do echo TMEX_SCROLL_\\$i; done" C-m`
    );

    await expect
      .poll(() =>
        page.evaluate(() => {
          const g = globalThis as any;
          const term = g.__tmexE2eXterm;
          if (!term) return 0;
          return term.buffer?.active?.baseY ?? 0;
        })
      )
      .toBeGreaterThan(50);

    const before = await page.evaluate(() => {
      const g = globalThis as any;
      const term = g.__tmexE2eXterm;
      if (!term) {
        return { viewportY: 0, baseY: 0 };
      }
      term.scrollToBottom();
      return {
        viewportY: term.buffer?.active?.viewportY ?? 0,
        baseY: term.buffer?.active?.baseY ?? 0,
      };
    });

    const terminal = page.locator('.xterm').first();
    await expect(terminal).toBeVisible();
    const box = await terminal.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    const x = box.x + box.width / 2;
    const startY = box.y + box.height * 0.35;
    const endY = box.y + box.height * 0.8;
    await swipe(page, '.xterm', { x, y: startY }, { x, y: endY });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const g = globalThis as any;
          const term = g.__tmexE2eXterm;
          if (!term) {
            return { viewportY: 0, baseY: 0 };
          }
          return {
            viewportY: term.buffer?.active?.viewportY ?? 0,
            baseY: term.buffer?.active?.baseY ?? 0,
          };
        })
      )
      .toEqual(
        expect.objectContaining({
          viewportY: expect.any(Number),
          baseY: expect.any(Number),
        })
      );

    const after = await page.evaluate(() => {
      const g = globalThis as any;
      const term = g.__tmexE2eXterm;
      if (!term) {
        return { viewportY: 0, baseY: 0 };
      }
      return {
        viewportY: term.buffer?.active?.viewportY ?? 0,
        baseY: term.buffer?.active?.baseY ?? 0,
      };
    });

    expect(before.baseY).toBeGreaterThan(50);
    expect(before.viewportY).toBe(before.baseY);
    expect(after.viewportY).toBeLessThan(before.viewportY);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
