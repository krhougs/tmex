import { beforeEach, describe, expect, mock, test } from 'bun:test';

class MemStorage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
}

if (typeof globalThis.localStorage === 'undefined') {
  const memStorage = new MemStorage();
  // @ts-ignore
  globalThis.localStorage = memStorage;
}
if (typeof globalThis.window === 'undefined') {
  // @ts-ignore
  globalThis.window = {
    localStorage: globalThis.localStorage,
    location: { origin: 'http://localhost:9663' },
  } as unknown as Window & typeof globalThis;
}

mock.module('i18next', () => {
  const changeLanguage = mock(() => Promise.resolve());
  return { default: { changeLanguage, t: (k: string) => k } };
});

const notificationsActual = await import('@tmex/notifications');
mock.module('@tmex/notifications', () => ({
  ...notificationsActual,
  playBellSound: mock(() => {}),
}));

const sentMessages: Array<{ kind: number; payload: Uint8Array }> = [];
const sendMock = mock((kind: number, payload: Uint8Array) => {
  sentMessages.push({ kind, payload });
});
const isReadyMock = mock(() => true);

function makeBuildFn(kind: number) {
  return (...args: unknown[]) => ({
    kind,
    payload: new TextEncoder().encode(JSON.stringify(args)),
  });
}

const wsActual = await import('@tmex/ws-client');
mock.module('@tmex/ws-client', () => {
  const stub = {
    send: sendMock,
    isReady: isReadyMock,
    onStateChange: () => () => {},
    onMessage: () => () => {},
    onError: () => () => {},
    onLatency: () => () => {},
    onChunkProgress: () => () => {},
    connect: () => {},
    disconnect: () => {},
    getState: () => 'READY',
    hasConnectedOnce: true,
    latencyMs: null,
    serverCapabilities: [],
  };
  return {
    ...wsActual,
    getBorshClient: () => stub,
    resetBorshClient: () => {},
    getSelectStateMachine: () => ({
      dispatch: () => {},
      cleanup: () => {},
      getTransaction: () => null,
    }),
    resetSelectStateMachine: () => {},
    generateSelectToken: () => new Uint8Array(16),
    buildDeviceConnect: makeBuildFn(0x0101),
    buildDeviceDisconnect: makeBuildFn(0x0103),
    buildTmuxSelect: makeBuildFn(0x0201),
    buildTmuxSelectWindow: makeBuildFn(0x0202),
    buildTmuxCreateWindow: makeBuildFn(0x0203),
    buildTmuxCloseWindow: makeBuildFn(0x0204),
    buildTmuxClosePane: makeBuildFn(0x0205),
    buildTmuxRenameWindow: makeBuildFn(0x0206),
    buildTmuxSetWindowStyle: (deviceId: string, style: string) => ({
      kind: 0x020a,
      payload: new TextEncoder().encode(`${deviceId}|${style}`),
    }),
    buildTmuxReorderWindows: makeBuildFn(0x020b),
    buildTmuxReorderPanes: makeBuildFn(0x020c),
    buildTmuxSubscribePanes: makeBuildFn(0x020d),
    buildTmuxFetchPaneHistory: makeBuildFn(0x020e),
    buildTmuxResizePane: makeBuildFn(0x020f),
    buildTmuxApplyStackedLayout: makeBuildFn(0x0210),
    buildTmuxSplitPane: makeBuildFn(0x0211),
    buildTmuxFocusPane: makeBuildFn(0x0212),
    buildTmuxRenamePane: makeBuildFn(0x0213),
    buildTmuxMovePane: makeBuildFn(0x0214),
    buildTmuxBreakPane: makeBuildFn(0x0215),
    buildTermInput: makeBuildFn(0x0301),
    buildTermPaste: makeBuildFn(0x0302),
    buildTermResize: makeBuildFn(0x0303),
    buildTermSyncSize: makeBuildFn(0x0304),
    buildAgentSubscribe: makeBuildFn(0x0601),
    buildAgentUnsubscribe: makeBuildFn(0x0602),
    buildSiteThemeUpdate: (theme: 'dark' | 'light') => ({
      kind: 0x0801,
      payload: new Uint8Array([theme === 'light' ? 1 : 0]),
    }),
    decodeDeviceConnected: () => ({ deviceId: '' }),
    decodeDeviceDisconnected: () => ({ deviceId: '' }),
    decodeDeviceEvent: () => ({ type: 'disconnected', deviceId: '' }),
    decodeStateSnapshot: () => ({ deviceId: '', session: { id: '', name: '', windows: [] } }),
    decodeTmuxEvent: () => ({ type: 'bell', deviceId: '', data: {} }),
    decodeTermOutput: () => ({ deviceId: '', paneId: '', encoding: 1, data: new Uint8Array() }),
    decodeTermHistory: () => ({
      deviceId: '',
      paneId: '',
      selectToken: new Uint8Array(16),
      encoding: 1,
      alternateScreen: false,
      data: new Uint8Array(),
    }),
    decodeSwitchAck: () => ({
      deviceId: '',
      windowId: '',
      paneId: '',
      selectToken: new Uint8Array(16),
    }),
    decodeLiveResume: () => ({ deviceId: '', paneId: '', selectToken: new Uint8Array(16) }),
    decodeError: () => ({ refSeq: 0, code: 0, message: '', retryable: false }),
    decodeSiteThemeUpdate: () => ({ theme: 0, serverTimestamp: 0n }),
  };
});

mock.module('@tmex/ws-client/pane-sink-registry', () => ({
  beginPaneHistoryGate: () => {},
  cleanupDevicePaneState: () => {},
  dispatchPaneApplyHistory: () => {},
  dispatchPaneHistory: () => false,
  dispatchPaneOutput: () => {},
  dispatchPaneReset: () => {},
}));

const { useTmuxStore, useUIStore } = await import('./index');

const KIND_TMUX_SET_WINDOW_STYLE = 0x020a;

describe('useTmuxStore syncThemeAfterResize', () => {
  beforeEach(() => {
    sentMessages.length = 0;
    sendMock.mockClear();
    isReadyMock.mockImplementation(() => true);
    useUIStore.setState({ theme: 'dark' });
  });

  test('syncThemeAfterResize sends KIND_TMUX_SET_WINDOW_STYLE for current theme', () => {
    useUIStore.setState({ theme: 'dark' });
    useTmuxStore.getState().syncThemeAfterResize('device-a');

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].kind).toBe(KIND_TMUX_SET_WINDOW_STYLE);
  });

  test('syncThemeAfterResize uses light style when UI theme is light', () => {
    useUIStore.setState({ theme: 'light' });
    useTmuxStore.getState().syncThemeAfterResize('device-a');

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].kind).toBe(KIND_TMUX_SET_WINDOW_STYLE);
    const payloadText = new TextDecoder().decode(sentMessages[0].payload);
    expect(payloadText).toContain('device-a');
    expect(payloadText).toContain('bg=#e1e1e1');
  });

  test('syncThemeAfterResize uses dark style when UI theme is dark', () => {
    useUIStore.setState({ theme: 'dark' });
    useTmuxStore.getState().syncThemeAfterResize('device-a');

    const payloadText = new TextDecoder().decode(sentMessages[0].payload);
    expect(payloadText).toContain('bg=#262626');
  });

  test('syncThemeAfterResize skips when deviceId is empty', () => {
    useTmuxStore.getState().syncThemeAfterResize('');

    expect(sentMessages.length).toBe(0);
  });

  test('syncThemeAfterResize skips when ws not ready', () => {
    isReadyMock.mockImplementation(() => false);
    useTmuxStore.getState().syncThemeAfterResize('device-a');

    expect(sentMessages.length).toBe(0);
  });
});
