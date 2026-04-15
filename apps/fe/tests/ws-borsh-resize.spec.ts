import { expect, test } from '@playwright/test';
import { createTwoPaneSession, ensureCleanSession, getPaneSize } from './helpers/tmux';
import { KIND, decodeEnvelope } from './helpers/ws-borsh';

async function readTerminalSize(page: Parameters<typeof test>[0]['page']): Promise<{
  cols: number;
  rows: number;
} | null> {
  return page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    if (!term) return null;
    return {
      cols: term.cols,
      rows: term.rows,
    };
  });
}

async function readTerminalLayout(page: Parameters<typeof test>[0]['page']): Promise<{
  hostHeight: number;
  xtermHeight: number;
  cellHeight: number;
} | null> {
  return page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    const host = document.querySelector(
      '[data-testid="device-page"] .flex-1.w-full > div.h-full.w-full.relative > div.absolute.inset-0'
    ) as HTMLElement | null;
    const xterm = document.querySelector('.xterm') as HTMLElement | null;
    const cellHeight = (term as any)?._core?._renderService?.dimensions?.css?.cell?.height;
    if (!term || !host || !xterm || typeof cellHeight !== 'number') {
      return null;
    }
    return {
      hostHeight: host.getBoundingClientRect().height,
      xtermHeight: xterm.getBoundingClientRect().height,
      cellHeight,
    };
  });
}

test('ws-borsh: resize does not spam TERM_RESIZE frames', async ({ page, request }) => {
  const sessionName = `tmex-e2e-resize-${Date.now()}`;
  createTwoPaneSession(sessionName);

  const name = `e2e-borsh-resize-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  let resizeCount = 0;

  page.on('websocket', (ws) => {
    if (!ws.url().endsWith('/ws')) return;
    ws.on('framesent', ({ payload }) => {
      const envelope = decodeEnvelope(payload as Buffer);
      if (!envelope) return;
      if (envelope.kind === KIND.TERM_RESIZE) {
        resizeCount += 1;
      }
    });
  });

  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.getByTestId('terminal-shortcuts-strip')).toBeVisible();

    resizeCount = 0;

    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForTimeout(800);

    expect(resizeCount <= 3).toBeTruthy();
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('ws-borsh: initial load and browser resize converge to tmux pane size', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-resize-sync-${Date.now()}`;
  const { paneIds } = createTwoPaneSession(sessionName);
  const targetPaneId = paneIds[0];

  const name = `e2e-borsh-resize-sync-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  try {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(
        async () => {
          const terminalSize = await readTerminalSize(page);
          const paneSize = getPaneSize(targetPaneId);
          if (!terminalSize) {
            return null;
          }
          return {
            terminalSize,
            paneSize,
          };
        },
        { timeout: 20_000 }
      )
      .toEqual({
        terminalSize: getPaneSize(targetPaneId),
        paneSize: getPaneSize(targetPaneId),
      });

    await page.setViewportSize({ width: 900, height: 700 });

    await expect
      .poll(
        async () => {
          const terminalSize = await readTerminalSize(page);
          const paneSize = getPaneSize(targetPaneId);
          if (!terminalSize) {
            return null;
          }
          return {
            terminalSize,
            paneSize,
          };
        },
        { timeout: 20_000 }
      )
      .toEqual({
        terminalSize: getPaneSize(targetPaneId),
        paneSize: getPaneSize(targetPaneId),
      });
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('ws-borsh: growing viewport converges to latest tmux pane size instead of snapping back', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-resize-grow-${Date.now()}`;
  const { paneIds } = createTwoPaneSession(sessionName);
  const targetPaneId = paneIds[0];

  const name = `e2e-borsh-resize-grow-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  try {
    await page.setViewportSize({ width: 1200, height: 700 });
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(
        async () => {
          const terminalSize = await readTerminalSize(page);
          const paneSize = getPaneSize(targetPaneId);
          if (!terminalSize) {
            return null;
          }
          return {
            terminalSize,
            paneSize,
          };
        },
        { timeout: 20_000 }
      )
      .toEqual({
        terminalSize: getPaneSize(targetPaneId),
        paneSize: getPaneSize(targetPaneId),
      });

    await page.setViewportSize({ width: 3840, height: 2160 });

    await expect
      .poll(
        async () => {
          const terminalSize = await readTerminalSize(page);
          const paneSize = getPaneSize(targetPaneId);
          if (!terminalSize) {
            return null;
          }
          return {
            terminalSize,
            paneSize,
          };
        },
        { timeout: 20_000 }
      )
      .toEqual({
        terminalSize: getPaneSize(targetPaneId),
        paneSize: getPaneSize(targetPaneId),
      });
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('ws-borsh: xterm viewport fills host height within one terminal row', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-resize-layout-${Date.now()}`;
  createTwoPaneSession(sessionName);

  const name = `e2e-borsh-resize-layout-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  try {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(
        async () => {
          const layout = await readTerminalLayout(page);
          if (!layout) {
            return null;
          }
          return layout.hostHeight - layout.xtermHeight <= layout.cellHeight + 2;
        },
        { timeout: 20_000 }
      )
      .toBe(true);

    await page.setViewportSize({ width: 900, height: 700 });

    await expect
      .poll(
        async () => {
          const layout = await readTerminalLayout(page);
          if (!layout) {
            return null;
          }
          return layout.hostHeight - layout.xtermHeight <= layout.cellHeight + 2;
        },
        { timeout: 20_000 }
      )
      .toBe(true);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
