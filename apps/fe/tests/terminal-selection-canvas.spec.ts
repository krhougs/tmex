import { type APIRequestContext, expect, test, type Page } from '@playwright/test';
import { createTwoPaneSession, ensureCleanSession, tmux } from './helpers/tmux';

const COPY_SHORTCUT = process.platform === 'darwin' ? 'Meta+C' : 'Control+C';

type VisibleTextRange = {
  row: number;
  startCol: number;
  endCol: number;
};

async function createDevice(
  request: APIRequestContext,
  sessionName: string,
  name: string
): Promise<string> {
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
  return created.device.id;
}

async function waitForCanvasTerminal(page: Page): Promise<void> {
  await expect(page.getByTestId('device-page')).toBeVisible();
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          return {
            renderer: (window as any).__tmexE2eTerminalRenderer ?? null,
            hasCanvas: Boolean(document.querySelector('.xterm canvas')),
          };
        }),
      { timeout: 20_000 }
    )
    .toEqual({
      renderer: 'canvas',
      hasCanvas: true,
    });
}

async function readVisibleTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    if (!term) {
      return '';
    }

    const buffer = term.buffer.active;
    const start = buffer.viewportY;
    const end = Math.min(buffer.length, start + term.rows);
    const lines: string[] = [];
    for (let y = start; y < end; y += 1) {
      const line = buffer.getLine(y);
      lines.push(line ? line.translateToString(false) : '');
    }

    return lines.join('\n');
  });
}

async function findVisibleTextRange(page: Page, needle: string): Promise<VisibleTextRange> {
  const match = await page.evaluate((target) => {
    const term = (window as any).__tmexE2eXterm;
    if (!term) {
      return null;
    }

    const buffer = term.buffer.active;
    const start = buffer.viewportY;
    const end = Math.min(buffer.length, start + term.rows);
    for (let y = start; y < end; y += 1) {
      const line = buffer.getLine(y);
      const text = line ? line.translateToString(false) : '';
      const startCol = text.indexOf(target);
      if (startCol >= 0) {
        return {
          row: y - start,
          startCol,
          endCol: startCol + target.length - 1,
        };
      }
    }

    return null;
  }, needle);

  if (!match) {
    throw new Error(`visible text not found: ${needle}`);
  }

  return match;
}

async function getCanvasMetrics(page: Page): Promise<{
  left: number;
  top: number;
  cellWidth: number;
  cellHeight: number;
}> {
  const metrics = await page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    const canvas = document.querySelector('.xterm canvas');
    if (!term || !(canvas instanceof HTMLCanvasElement)) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    const cell = term._core?._renderService?.dimensions?.css?.cell;
    return {
      left: rect.left,
      top: rect.top,
      cellWidth: Number(cell?.width ?? 0),
      cellHeight: Number(cell?.height ?? 0),
    };
  });

  if (!metrics) {
    throw new Error('canvas metrics unavailable');
  }

  return metrics;
}

async function cellCenter(
  page: Page,
  row: number,
  col: number
): Promise<{
  x: number;
  y: number;
}> {
  const metrics = await getCanvasMetrics(page);
  return {
    x: metrics.left + (col + 0.5) * metrics.cellWidth,
    y: metrics.top + (row + 0.5) * metrics.cellHeight,
  };
}

async function dragVisibleText(page: Page, needle: string): Promise<void> {
  const range = await findVisibleTextRange(page, needle);
  const start = await cellCenter(page, range.row, range.startCol);
  const end = await cellCenter(page, range.row, range.endCol);

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
}

async function clickVisibleText(page: Page, needle: string, clickCount: number): Promise<void> {
  const range = await findVisibleTextRange(page, needle);
  const target = await cellCenter(page, range.row, range.startCol);
  await page.mouse.click(target.x, target.y, { clickCount });
}

async function readSelectionText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    return (window as any).__tmexE2eTerminalSelectionText ?? null;
  });
}

async function readClipboardText(page: Page): Promise<string> {
  return page.evaluate(async () => navigator.clipboard.readText());
}

test('desktop: canvas selection supports drag, double click, triple click and copy', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-canvas-selection-${Date.now()}`;
  createTwoPaneSession(sessionName);

  const deviceId = await createDevice(
    request,
    sessionName,
    `e2e-canvas-selection-${Date.now()}`
  );

  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`/devices/${deviceId}`);
    await waitForCanvasTerminal(page);

    tmux(
      `send-keys -t ${sessionName}.0 "printf 'dragtarget\\r\\ndbltoken keep\\r\\ntripline\\r\\n'" C-m`
    );

    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).toContain(
      'dragtarget'
    );

    await dragVisibleText(page, 'dragtarget');
    await expect.poll(() => readSelectionText(page), { timeout: 10_000 }).toBe(
      'dragtarget'
    );

    await clickVisibleText(page, 'dbltoken', 2);
    await expect.poll(() => readSelectionText(page), { timeout: 10_000 }).toBe('dbltoken');

    await clickVisibleText(page, 'tripline', 3);
    await expect.poll(() => readSelectionText(page), { timeout: 10_000 }).toContain('tripline');

    await page.keyboard.press(COPY_SHORTCUT);
    await expect.poll(() => readClipboardText(page), { timeout: 10_000 }).toContain('tripline');
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('desktop: pane switch, reconnect and resize should clear canvas selection state', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-canvas-selection-reset-${Date.now()}`;
  const { paneIds, windowId } = createTwoPaneSession(sessionName);
  expect(paneIds.length >= 2).toBeTruthy();

  const deviceId = await createDevice(
    request,
    sessionName,
    `e2e-canvas-selection-reset-${Date.now()}`
  );
  const pane0Path = `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneIds[0] ?? '')}`;
  const pane1Path = `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneIds[1] ?? '')}`;

  try {
    tmux(`send-keys -t ${sessionName}.0 "printf 'panezero\\r\\n'" C-m`);
    tmux(`send-keys -t ${sessionName}.1 "printf 'paneone\\r\\n'" C-m`);

    await page.goto(pane0Path);
    await waitForCanvasTerminal(page);
    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).toContain('panezero');

    await dragVisibleText(page, 'panezero');
    await expect.poll(() => readSelectionText(page), { timeout: 10_000 }).toBe('panezero');

    await page.goto(pane1Path);
    await waitForCanvasTerminal(page);
    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).toContain('paneone');
    await expect.poll(() => readSelectionText(page), { timeout: 10_000 }).toBeNull();

    await page.reload();
    await waitForCanvasTerminal(page);
    await expect.poll(() => readSelectionText(page), { timeout: 10_000 }).toBeNull();

    await page.setViewportSize({ width: 1280, height: 720 });
    await waitForCanvasTerminal(page);
    await expect.poll(() => readSelectionText(page), { timeout: 10_000 }).toBeNull();
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('desktop: dragging outside viewport should auto scroll and extend canvas selection', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-canvas-selection-autoscroll-${Date.now()}`;
  createTwoPaneSession(sessionName);

  const deviceId = await createDevice(
    request,
    sessionName,
    `e2e-canvas-selection-autoscroll-${Date.now()}`
  );

  try {
    await page.goto(`/devices/${deviceId}`);
    await waitForCanvasTerminal(page);

    tmux(`send-keys -t ${sessionName}.0 "seq 1 140 | sed 's/^/AS_/'" C-m`);

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const term = (window as any).__tmexE2eXterm;
            return term?.buffer?.active?.baseY ?? 0;
          }),
        { timeout: 20_000 }
      )
      .toBeGreaterThan(80);

    await page.evaluate(() => {
      const term = (window as any).__tmexE2eXterm;
      term?.scrollToBottom();
    });

    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).toContain('AS_140');

    const bottomRange = await findVisibleTextRange(page, 'AS_140');
    const start = await cellCenter(page, bottomRange.row, bottomRange.endCol);
    const metrics = await getCanvasMetrics(page);

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, metrics.top + metrics.cellHeight * 0.5, { steps: 8 });
    await page.mouse.move(start.x, metrics.top - metrics.cellHeight * 3, { steps: 16 });
    await page.waitForTimeout(1200);
    await page.mouse.up();

    const selectionText = await readSelectionText(page);
    expect(selectionText).toContain('AS_140');

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const term = (window as any).__tmexE2eXterm;
            return term?.buffer?.active?.viewportY ?? 0;
          }),
        { timeout: 10_000 }
      )
      .toBeLessThan(100);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
