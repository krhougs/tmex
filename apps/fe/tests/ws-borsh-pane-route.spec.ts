import { type Page, expect, test } from '@playwright/test';
import { wsBorsh } from '@tmex/shared';
import { createTwoPaneSession, ensureCleanSession } from './helpers/tmux';

async function readVisibleTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    if (!term) return '';
    const buffer = term.buffer.active;
    const start = buffer.viewportY;
    const end = Math.min(buffer.length, start + term.rows);
    const lines: string[] = [];
    for (let y = start; y < end; y++) {
      const line = buffer.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n');
  });
}

test('ws-borsh: direct pane route preserves encoded pane id and loads target pane', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-pane-route-${Date.now()}`;
  const { paneIds, windowId } = createTwoPaneSession(sessionName);
  expect(paneIds.length >= 2).toBeTruthy();

  const name = `e2e-borsh-pane-route-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  const targetPaneId = paneIds[1];
  const targetPath = `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(targetPaneId)}`;

  const received: {
    selectTokenByPane: Map<string, string>;
    historyTextByToken: Map<string, string>;
  } = {
    selectTokenByPane: new Map(),
    historyTextByToken: new Map(),
  };

  const reassembler = new wsBorsh.ChunkReassembler();

  page.on('websocket', (socket) => {
    if (!socket.url().endsWith('/ws')) return;

    socket.on('framesent', (frame) => {
      const payload = frame.payload;
      if (typeof payload === 'string') return;

      const bytes =
        payload instanceof Buffer ? new Uint8Array(payload) : new Uint8Array(payload as any);
      if (!wsBorsh.checkMagic(bytes)) return;

      const envelope = wsBorsh.decodeEnvelope(bytes);

      let kind = envelope.kind;
      let payloadBytes = envelope.payload;

      if (kind === wsBorsh.KIND_CHUNK) {
        const chunk = wsBorsh.decodeChunk(payloadBytes);
        const reassembled = reassembler.addChunk(chunk);
        if (!reassembled) return;
        kind = reassembled.kind;
        payloadBytes = reassembled.payload;
      }

      if (kind !== wsBorsh.KIND_TMUX_SELECT) return;

      const decoded = wsBorsh.decodePayload(wsBorsh.schema.TmuxSelectSchema, payloadBytes);
      if (!decoded.paneId) return;
      received.selectTokenByPane.set(
        decoded.paneId,
        Buffer.from(decoded.selectToken).toString('hex')
      );
    });

    socket.on('framereceived', (frame) => {
      const payload = frame.payload;
      if (typeof payload === 'string') return;

      const bytes =
        payload instanceof Buffer ? new Uint8Array(payload) : new Uint8Array(payload as any);
      if (!wsBorsh.checkMagic(bytes)) return;

      const envelope = wsBorsh.decodeEnvelope(bytes);

      let kind = envelope.kind;
      let payloadBytes = envelope.payload;

      if (kind === wsBorsh.KIND_CHUNK) {
        const chunk = wsBorsh.decodeChunk(payloadBytes);
        const reassembled = reassembler.addChunk(chunk);
        if (!reassembled) return;
        kind = reassembled.kind;
        payloadBytes = reassembled.payload;
      }

      if (kind !== wsBorsh.KIND_TERM_HISTORY) return;

      const decoded = wsBorsh.decodePayload(wsBorsh.schema.TermHistorySchema, payloadBytes);
      const tokenHex = Buffer.from(decoded.selectToken).toString('hex');
      received.historyTextByToken.set(tokenHex, new TextDecoder().decode(decoded.data));
    });
  });

  try {
    await page.goto(targetPath);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(() => page.evaluate(() => window.location.pathname), { timeout: 20_000 })
      .toBe(targetPath);

    await expect
      .poll(() => received.selectTokenByPane.get(targetPaneId) ?? null, { timeout: 20_000 })
      .toBeTruthy();

    const tokenHex = received.selectTokenByPane.get(targetPaneId);
    expect(tokenHex).toBeTruthy();

    await expect
      .poll(() => received.historyTextByToken.get(tokenHex ?? '') ?? '', { timeout: 20_000 })
      .toContain('PANE1_READY');

    await expect
      .poll(() => readVisibleTerminalText(page), { timeout: 20_000 })
      .toContain('PANE1_READY');

    await page.waitForTimeout(1000);
    await expect(page.evaluate(() => window.location.pathname)).resolves.toBe(targetPath);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
