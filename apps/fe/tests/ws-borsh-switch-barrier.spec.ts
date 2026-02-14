import { expect, test } from '@playwright/test';
import {
  KIND,
  decodeEnvelope,
  decodeLiveResume,
  decodeSwitchAck,
  decodeTermHistory,
  decodeTmuxSelect,
} from './helpers/ws-borsh';
import { createTwoPaneSession, ensureCleanSession } from './helpers/tmux';

test('ws-borsh: TMUX_SELECT carries cols/rows and barrier order is ACK->HISTORY->RESUME', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-barrier-${Date.now()}`;
  const { paneIds } = createTwoPaneSession(sessionName);
  expect(paneIds.length >= 2).toBeTruthy();

  const name = `e2e-borsh-barrier-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  const observed: {
    select: Array<{ tokenHex: string; paneId: string | null; cols: number | null; rows: number | null }>;
    barrier: Map<string, number[]>;
  } = {
    select: [],
    barrier: new Map(),
  };

  let targetTokenHex: string | null = null;
  let targetPaneId: string | null = null;

  page.on('websocket', (ws) => {
    if (!ws.url().endsWith('/ws')) return;

    ws.on('framesent', ({ payload }) => {
      const envelope = decodeEnvelope(payload as Buffer);
      if (!envelope) return;
      if (envelope.kind !== KIND.TMUX_SELECT) return;
      const select = decodeTmuxSelect(envelope.payload);
      const tokenHex = select.selectToken.toString('hex');
      observed.select.push({ tokenHex, paneId: select.paneId, cols: select.cols, rows: select.rows });

      if (targetPaneId && select.paneId === targetPaneId) {
        targetTokenHex = tokenHex;
      }
    });

    ws.on('framereceived', ({ payload }) => {
      const envelope = decodeEnvelope(payload as Buffer);
      if (!envelope) return;
      if (!targetTokenHex) return;

      if (envelope.kind === KIND.SWITCH_ACK) {
        const ack = decodeSwitchAck(envelope.payload);
        if (ack.selectToken.toString('hex') !== targetTokenHex) return;
        const list = observed.barrier.get(targetTokenHex) ?? [];
        list.push(KIND.SWITCH_ACK);
        observed.barrier.set(targetTokenHex, list);
        return;
      }

      if (envelope.kind === KIND.TERM_HISTORY) {
        const history = decodeTermHistory(envelope.payload);
        if (history.selectToken.toString('hex') !== targetTokenHex) return;
        const list = observed.barrier.get(targetTokenHex) ?? [];
        list.push(KIND.TERM_HISTORY);
        observed.barrier.set(targetTokenHex, list);
        return;
      }

      if (envelope.kind === KIND.LIVE_RESUME) {
        const resume = decodeLiveResume(envelope.payload);
        if (resume.selectToken.toString('hex') !== targetTokenHex) return;
        const list = observed.barrier.get(targetTokenHex) ?? [];
        list.push(KIND.LIVE_RESUME);
        observed.barrier.set(targetTokenHex, list);
      }
    });
  });

  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();

    const targetPane = paneIds[1];
    targetPaneId = targetPane;

    await expect(page.getByTestId(`pane-item-${targetPane}`)).toBeVisible({ timeout: 20_000 });
    await page.getByTestId(`pane-item-${targetPane}`).click();

    await expect.poll(() => targetTokenHex, { timeout: 20_000 }).toBeTruthy();

    const capturedSelect = observed.select.find((s) => s.tokenHex === targetTokenHex);
    expect(capturedSelect).toBeTruthy();
    expect(capturedSelect?.cols).not.toBeNull();
    expect(capturedSelect?.rows).not.toBeNull();
    expect((capturedSelect?.cols ?? 0) > 1).toBeTruthy();
    expect((capturedSelect?.rows ?? 0) > 1).toBeTruthy();

    await expect.poll(() => observed.barrier.get(targetTokenHex!) ?? [], { timeout: 20_000 }).toContain(
      KIND.SWITCH_ACK
    );
    await expect.poll(() => observed.barrier.get(targetTokenHex!) ?? [], { timeout: 20_000 }).toContain(
      KIND.LIVE_RESUME
    );

    const seq = observed.barrier.get(targetTokenHex!) ?? [];
    const ackIndex = seq.indexOf(KIND.SWITCH_ACK);
    const historyIndex = seq.indexOf(KIND.TERM_HISTORY);
    const resumeIndex = seq.indexOf(KIND.LIVE_RESUME);

    expect(ackIndex >= 0).toBeTruthy();
    expect(resumeIndex > ackIndex).toBeTruthy();
    if (historyIndex >= 0) {
      expect(historyIndex > ackIndex).toBeTruthy();
      expect(resumeIndex > historyIndex).toBeTruthy();
    }
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('ws-borsh: rapid select cancels previous transaction (no LIVE_RESUME for old token)', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-rapid-${Date.now()}`;
  const { paneIds } = createTwoPaneSession(sessionName);
  expect(paneIds.length >= 2).toBeTruthy();

  const name = `e2e-borsh-rapid-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  const selectTokenByPane = new Map<string, string>();
  const liveResumes: string[] = [];

  page.on('websocket', (ws) => {
    if (!ws.url().endsWith('/ws')) return;

    ws.on('framesent', ({ payload }) => {
      const envelope = decodeEnvelope(payload as Buffer);
      if (!envelope || envelope.kind !== KIND.TMUX_SELECT) return;
      const select = decodeTmuxSelect(envelope.payload);
      if (!select.paneId) return;
      selectTokenByPane.set(select.paneId, select.selectToken.toString('hex'));
    });

    ws.on('framereceived', ({ payload }) => {
      const envelope = decodeEnvelope(payload as Buffer);
      if (!envelope || envelope.kind !== KIND.LIVE_RESUME) return;
      const resume = decodeLiveResume(envelope.payload);
      liveResumes.push(resume.selectToken.toString('hex'));
    });
  });

  const firstPane = paneIds[0];
  const secondPane = paneIds[1];

  let tokenA: string | null = null;
  let tokenB: string | null = null;

  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();

    await expect(page.getByTestId(`pane-item-${firstPane}`)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`pane-item-${secondPane}`)).toBeVisible({ timeout: 20_000 });

    // 页面可能会在初始加载时自动 select 当前 active pane；
    // 本用例只关心这两次点击触发的 token，因此需要等待 token 发生变化。
    const initialTokenFirst = selectTokenByPane.get(firstPane) ?? null;
    const initialTokenSecond = selectTokenByPane.get(secondPane) ?? null;

    await page.getByTestId(`pane-item-${secondPane}`).click();
    await page.getByTestId(`pane-item-${firstPane}`).click();

    await expect
      .poll(() => {
        const next = selectTokenByPane.get(secondPane) ?? '';
        if (!next) return '';
        if (initialTokenSecond && next === initialTokenSecond) return '';
        return next;
      }, { timeout: 20_000 })
      .not.toBe('');

    await expect
      .poll(() => {
        const next = selectTokenByPane.get(firstPane) ?? '';
        if (!next) return '';
        if (initialTokenFirst && next === initialTokenFirst) return '';
        return next;
      }, { timeout: 20_000 })
      .not.toBe('');

    tokenA = selectTokenByPane.get(secondPane) ?? null;
    tokenB = selectTokenByPane.get(firstPane) ?? null;

    await expect
      .poll(() => liveResumes.includes(tokenB!), { timeout: 20_000 })
      .toBeTruthy();

    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(liveResumes.includes(tokenA!)).toBeFalsy();
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
