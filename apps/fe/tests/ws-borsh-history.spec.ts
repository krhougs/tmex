import { expect, test, type Page } from '@playwright/test';
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

test('ws-borsh: applies TERM_HISTORY on initial load (shows pane ready marker)', async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    (window as any).__TMEX_E2E_DEBUG = true;
  });

  const received: {
    selectTokenByPane: Map<string, string>;
    barrierKindsByToken: Map<string, number[]>;
    historyTextByToken: Map<string, string>;
  } = {
    selectTokenByPane: new Map(),
    barrierKindsByToken: new Map(),
    historyTextByToken: new Map(),
  };

  const reassembler = new wsBorsh.ChunkReassembler();

  page.on('websocket', (socket) => {
    if (!socket.url().endsWith('/ws')) return;

    socket.on('framesent', (frame) => {
      const payload = frame.payload;
      if (typeof payload === 'string') return;

      const bytes = payload instanceof Buffer ? new Uint8Array(payload) : new Uint8Array(payload as any);
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
      const tokenHex = Buffer.from(decoded.selectToken).toString('hex');
      received.selectTokenByPane.set(decoded.paneId, tokenHex);
    });

    socket.on('framereceived', (frame) => {
      const payload = frame.payload;
      if (typeof payload === 'string') return;

      const bytes = payload instanceof Buffer ? new Uint8Array(payload) : new Uint8Array(payload as any);
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

      if (kind === wsBorsh.KIND_SWITCH_ACK) {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.SwitchAckSchema, payloadBytes);
        const tokenHex = Buffer.from(decoded.selectToken).toString('hex');
        const list = received.barrierKindsByToken.get(tokenHex) ?? [];
        list.push(kind);
        received.barrierKindsByToken.set(tokenHex, list);
        return;
      }

      if (kind === wsBorsh.KIND_LIVE_RESUME) {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.LiveResumeSchema, payloadBytes);
        const tokenHex = Buffer.from(decoded.selectToken).toString('hex');
        const list = received.barrierKindsByToken.get(tokenHex) ?? [];
        list.push(kind);
        received.barrierKindsByToken.set(tokenHex, list);
        return;
      }

      if (kind === wsBorsh.KIND_TERM_HISTORY) {
        const decoded = wsBorsh.decodePayload(wsBorsh.schema.TermHistorySchema, payloadBytes);
        const tokenHex = Buffer.from(decoded.selectToken).toString('hex');
        const text = new TextDecoder().decode(decoded.data);
        received.historyTextByToken.set(tokenHex, text);
        const list = received.barrierKindsByToken.get(tokenHex) ?? [];
        list.push(kind);
        received.barrierKindsByToken.set(tokenHex, list);
      }
    });
  });

  const sessionName = `tmex-e2e-history-${Date.now()}`;
  const { paneIds } = createTwoPaneSession(sessionName);
  expect(paneIds.length >= 1).toBeTruthy();

  const name = `e2e-borsh-history-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;
  const targetPaneId = paneIds[0];

  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();

    // Wait for xterm to appear and history to be applied.
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => Boolean((window as any).__tmexE2eXterm)), { timeout: 20_000 }).toBeTruthy();
    await expect.poll(() => received.selectTokenByPane.get(targetPaneId) ?? null, { timeout: 20_000 }).toBeTruthy();

    const tokenHex = received.selectTokenByPane.get(targetPaneId)!;
    await expect.poll(() => received.historyTextByToken.get(tokenHex) ?? '', { timeout: 20_000 }).toContain(
      'PANE0_READY'
    );
    await expect.poll(() => received.barrierKindsByToken.get(tokenHex) ?? [], { timeout: 20_000 }).toContain(
      wsBorsh.KIND_SWITCH_ACK
    );
    await expect.poll(() => received.barrierKindsByToken.get(tokenHex) ?? [], { timeout: 20_000 }).toContain(
      wsBorsh.KIND_LIVE_RESUME
    );

    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).toContain('PANE0_READY');
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
