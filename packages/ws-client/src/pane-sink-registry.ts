// per-pane 输出/历史分发注册表（分屏多 Terminal 实例的路由核心）
//
// 每个 Terminal 实例挂载时以 (deviceId, paneId) 注册一个 sink，卸载时注销。
// 选择状态机与 store 的消息处理统一通过本模块把字节流路由到对应实例：
// - sink 未注册时缓冲有限量输出（Terminal 挂载瞬间的竞态），注册时重放；
// - fetch-history gate：非焦点 pane 主动拉取首屏时，先缓冲 live 输出，
//   history 应用后再 flush，保证内容顺序（带超时兜底放行）。

// reset 来源：select = 切换/选择流程（随后会有 post-select 尺寸上报）；
// history-refresh = 远端 resize 等触发的内容重建，不得携带本地尺寸上报，
// 否则两个不同视口的客户端会互相抢 window 尺寸形成拉锯
import type {
  GatewayPaneHistoryPage,
  GatewayPaneScreenSnapshot,
  GatewayRebaseReason,
  GatewayTerminalData,
  GatewayKittyGraphicsMessage,
} from './transport';

export type PaneResetOrigin = 'select' | 'history-refresh';

export interface PaneSink {
  onReset(origin: PaneResetOrigin): void;
  onApplyHistory(data: string, alternateScreen: boolean, modes: number): void;
  onOutput(data: Uint8Array, frame?: GatewayTerminalData): void;
  /** kitty 图片协议级分流事件（state.graphics.v1；未实现表示走内联 APC 老路径）。 */
  onKittyGraphics?(message: GatewayKittyGraphicsMessage): void;
  onScreenSnapshot?(snapshot: GatewayPaneScreenSnapshot): void;
  onHistoryPage?(page: GatewayPaneHistoryPage): void;
  onRebase?(reason: GatewayRebaseReason): void;
}

interface PendingPaneState {
  outputs: GatewayTerminalData[];
  outputBytes: number;
  reset: boolean;
  history: { data: string; alternateScreen: boolean; modes: number } | null;
  screen: GatewayPaneScreenSnapshot | null;
  historyPages: GatewayPaneHistoryPage[];
  rebase: GatewayRebaseReason | null;
}

interface HistoryGate {
  token: Uint8Array;
  buffer: Uint8Array[];
  bufferBytes: number;
  timer: ReturnType<typeof setTimeout>;
}

const MAX_PENDING_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_HISTORY_PAGES = 16;
const HISTORY_GATE_TIMEOUT_MS = 3000;

function paneKey(deviceId: string, paneId: string): string {
  return `${deviceId}:${paneId}`;
}

function tokensEqual(expected: Uint8Array, received: Uint8Array): boolean {
  if (expected.length !== received.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== received[i]) return false;
  }
  return true;
}

function splitPaneKey(key: string): [string, string] {
  const idx = key.lastIndexOf(':');
  return [key.slice(0, idx), key.slice(idx + 1)];
}

// 每个 gateway 连接一份注册表实例；模块级函数代理到默认实例（单连接宿主零改动）
export class PaneSinkRegistry {
  private sinks = new Map<string, PaneSink>();
  private sinkListeners = new Set<() => void>();
  private pending = new Map<string, PendingPaneState>();
  private historyGates = new Map<string, HistoryGate>();

  private getPending(key: string): PendingPaneState {
    let state = this.pending.get(key);
    if (!state) {
      state = {
        outputs: [],
        outputBytes: 0,
        reset: false,
        history: null,
        screen: null,
        historyPages: [],
        rebase: null,
      };
      this.pending.set(key, state);
    }
    return state;
  }

  registerPaneSink(deviceId: string, paneId: string, sink: PaneSink): () => void {
    const key = paneKey(deviceId, paneId);
    const wasAttached = this.sinks.has(key);
    this.sinks.set(key, sink);
    if (!wasAttached) this.notifyPaneSinkChange();

    const state = this.pending.get(key);
    if (state) {
      this.pending.delete(key);
      if (state.reset) {
        sink.onReset('select');
      }
      if (state.history) {
        sink.onApplyHistory(state.history.data, state.history.alternateScreen, state.history.modes);
      }
      if (state.rebase) sink.onRebase?.(state.rebase);
      if (state.screen) sink.onScreenSnapshot?.(state.screen);
      for (const page of state.historyPages) sink.onHistoryPage?.(page);
      // 缓冲的 live 字节只有跟在画面基线（reset/history/screen）之后回放才有意义；
      // 没有基线时它们是任意时刻的流中片段，写进全新空终端只会闪现陈旧乱码
      //（canonical 路径挂载后总会重新拉快照，丢弃无损）。
      if (state.reset || state.history || state.screen) {
        for (const frame of state.outputs) {
          sink.onOutput(frame.data, frame);
        }
      }
    }

    return () => {
      if (this.sinks.get(key) === sink) {
        this.sinks.delete(key);
        this.notifyPaneSinkChange();
      }
    };
  }

  onPaneSinkChange(listener: () => void): () => void {
    this.sinkListeners.add(listener);
    return () => this.sinkListeners.delete(listener);
  }

  private notifyPaneSinkChange(): void {
    for (const listener of [...this.sinkListeners]) listener();
  }

  dispatchPaneReset(deviceId: string, paneId: string, origin: PaneResetOrigin = 'select'): void {
    const key = paneKey(deviceId, paneId);
    const sink = this.sinks.get(key);
    if (sink) {
      sink.onReset(origin);
      return;
    }
    const state = this.getPending(key);
    state.reset = true;
    state.outputs = [];
    state.outputBytes = 0;
    state.history = null;
    state.screen = null;
    state.historyPages = [];
    state.rebase = null;
  }

  dispatchPaneApplyHistory(
    deviceId: string,
    paneId: string,
    data: string,
    alternateScreen: boolean,
    modes: number
  ): void {
    const key = paneKey(deviceId, paneId);
    const sink = this.sinks.get(key);
    if (sink) {
      sink.onApplyHistory(data, alternateScreen, modes);
      return;
    }
    this.getPending(key).history = { data, alternateScreen, modes };
  }

  dispatchPaneOutput(deviceId: string, paneId: string, data: Uint8Array): void {
    this.dispatchPaneTerminalData({ deviceId, paneId, data });
  }

  /** kitty graphics 消息面向该实例全部挂载终端（图片库是实例级，不是 pane 级）。 */
  dispatchKittyGraphics(message: GatewayKittyGraphicsMessage): void {
    for (const sink of this.sinks.values()) {
      sink.onKittyGraphics?.(message);
    }
  }

  dispatchPaneTerminalData(frame: GatewayTerminalData): void {
    const { deviceId, paneId } = frame;
    const key = paneKey(deviceId, paneId);

    const gate = this.historyGates.get(key);
    if (gate) {
      if (gate.bufferBytes + frame.data.byteLength > MAX_PENDING_OUTPUT_BYTES) {
        this.closePaneHistoryGate(key, { flush: false });
        this.dispatchPaneRebase(deviceId, paneId, 'resource_exhausted');
        return;
      }
      const data = new Uint8Array(frame.data);
      gate.buffer.push(data);
      gate.bufferBytes += data.byteLength;
      return;
    }

    const sink = this.sinks.get(key);
    if (sink) {
      sink.onOutput(frame.data, frame);
      return;
    }

    const state = this.getPending(key);
    if (state.outputBytes + frame.data.byteLength > MAX_PENDING_OUTPUT_BYTES) {
      state.outputs = [];
      state.outputBytes = 0;
      state.screen = null;
      state.historyPages = [];
      state.rebase = 'resource_exhausted';
      return;
    }
    const pendingFrame = { ...frame, data: new Uint8Array(frame.data) };
    state.outputs.push(pendingFrame);
    state.outputBytes += pendingFrame.data.byteLength;
  }

  dispatchPaneScreenSnapshot(snapshot: GatewayPaneScreenSnapshot): void {
    const key = paneKey(snapshot.deviceId, snapshot.paneId);
    const sink = this.sinks.get(key);
    if (sink?.onScreenSnapshot) {
      sink.onScreenSnapshot(snapshot);
      return;
    }
    const state = this.getPending(key);
    state.screen = snapshot;
    state.historyPages = [];
    state.rebase = null;
  }

  dispatchPaneHistoryPage(page: GatewayPaneHistoryPage): void {
    const key = paneKey(page.deviceId, page.paneId);
    const sink = this.sinks.get(key);
    if (sink?.onHistoryPage) {
      sink.onHistoryPage(page);
      return;
    }
    const state = this.getPending(key);
    if (state.historyPages.length >= MAX_PENDING_HISTORY_PAGES) {
      state.historyPages = [];
      state.screen = null;
      state.rebase = 'resource_exhausted';
      return;
    }
    state.historyPages.push(page);
  }

  dispatchPaneRebase(deviceId: string, paneId: string, reason: GatewayRebaseReason): void {
    const key = paneKey(deviceId, paneId);
    const sink = this.sinks.get(key);
    if (sink?.onRebase) {
      sink.onRebase(reason);
      return;
    }
    const state = this.getPending(key);
    state.screen = null;
    state.historyPages = [];
    state.outputs = [];
    state.outputBytes = 0;
    state.rebase = reason;
  }

  // 开始 fetch-history 门控：此后该 pane 的 live 输出被缓冲，直到
  // dispatchPaneHistory 命中 token 或超时兜底放行
  beginPaneHistoryGate(deviceId: string, paneId: string, token: Uint8Array): void {
    const key = paneKey(deviceId, paneId);
    this.closePaneHistoryGate(key, { flush: true });

    const timer = setTimeout(() => {
      console.warn(`[pane-sink] history gate timeout on ${key}, releasing buffered output`);
      this.closePaneHistoryGate(key, { flush: true });
    }, HISTORY_GATE_TIMEOUT_MS);

    this.historyGates.set(key, {
      token: new Uint8Array(token),
      buffer: [],
      bufferBytes: 0,
      timer,
    });
  }

  // KIND_TERM_HISTORY 到达时先尝试本函数；token 命中 gate 才消费（返回 true），
  // 否则返回 false 交由选择状态机处理（select 路径）
  dispatchPaneHistory(
    deviceId: string,
    paneId: string,
    token: Uint8Array,
    data: string,
    alternateScreen: boolean,
    modes: number
  ): boolean {
    const key = paneKey(deviceId, paneId);
    const gate = this.historyGates.get(key);
    if (!gate || !tokensEqual(gate.token, token)) {
      return false;
    }

    clearTimeout(gate.timer);
    this.historyGates.delete(key);

    this.dispatchPaneReset(deviceId, paneId, 'history-refresh');
    this.dispatchPaneApplyHistory(deviceId, paneId, data, alternateScreen, modes);
    for (const buffered of gate.buffer) {
      this.dispatchPaneOutput(deviceId, paneId, buffered);
    }
    return true;
  }

  private closePaneHistoryGate(key: string, opts: { flush: boolean }): void {
    const gate = this.historyGates.get(key);
    if (!gate) return;
    clearTimeout(gate.timer);
    this.historyGates.delete(key);
    if (opts.flush) {
      const [deviceId, paneId] = splitPaneKey(key);
      for (const buffered of gate.buffer) {
        this.dispatchPaneOutput(deviceId, paneId, buffered);
      }
    }
  }

  hasPaneSink(deviceId: string, paneId: string): boolean {
    return this.sinks.has(paneKey(deviceId, paneId));
  }

  // device 断开/切换时清理该 device 的所有 pending/gate（sink 由组件卸载自行注销）
  cleanupDevicePaneState(deviceId: string): void {
    const prefix = `${deviceId}:`;
    for (const key of this.pending.keys()) {
      if (key.startsWith(prefix)) {
        this.pending.delete(key);
      }
    }
    for (const key of this.historyGates.keys()) {
      if (key.startsWith(prefix)) {
        this.closePaneHistoryGate(key, { flush: false });
      }
    }
  }

  reset(): void {
    const hadSinks = this.sinks.size > 0;
    this.sinks.clear();
    this.pending.clear();
    for (const key of this.historyGates.keys()) {
      this.closePaneHistoryGate(key, { flush: false });
    }
    if (hadSinks) this.notifyPaneSinkChange();
  }
}

// 默认实例与模块级代理（保持既有调用面不变）
const defaultRegistry = new PaneSinkRegistry();

export function getDefaultPaneSinkRegistry(): PaneSinkRegistry {
  return defaultRegistry;
}

export function registerPaneSink(deviceId: string, paneId: string, sink: PaneSink): () => void {
  return defaultRegistry.registerPaneSink(deviceId, paneId, sink);
}

export function dispatchPaneReset(
  deviceId: string,
  paneId: string,
  origin: PaneResetOrigin = 'select'
): void {
  defaultRegistry.dispatchPaneReset(deviceId, paneId, origin);
}

export function dispatchPaneApplyHistory(
  deviceId: string,
  paneId: string,
  data: string,
  alternateScreen: boolean,
  modes: number
): void {
  defaultRegistry.dispatchPaneApplyHistory(deviceId, paneId, data, alternateScreen, modes);
}

export function dispatchPaneOutput(deviceId: string, paneId: string, data: Uint8Array): void {
  defaultRegistry.dispatchPaneOutput(deviceId, paneId, data);
}

export function dispatchPaneTerminalData(frame: GatewayTerminalData): void {
  defaultRegistry.dispatchPaneTerminalData(frame);
}

export function dispatchPaneScreenSnapshot(snapshot: GatewayPaneScreenSnapshot): void {
  defaultRegistry.dispatchPaneScreenSnapshot(snapshot);
}

export function dispatchPaneHistoryPage(page: GatewayPaneHistoryPage): void {
  defaultRegistry.dispatchPaneHistoryPage(page);
}

export function dispatchPaneRebase(
  deviceId: string,
  paneId: string,
  reason: GatewayRebaseReason
): void {
  defaultRegistry.dispatchPaneRebase(deviceId, paneId, reason);
}

export function beginPaneHistoryGate(deviceId: string, paneId: string, token: Uint8Array): void {
  defaultRegistry.beginPaneHistoryGate(deviceId, paneId, token);
}

export function dispatchPaneHistory(
  deviceId: string,
  paneId: string,
  token: Uint8Array,
  data: string,
  alternateScreen: boolean,
  modes: number
): boolean {
  return defaultRegistry.dispatchPaneHistory(deviceId, paneId, token, data, alternateScreen, modes);
}

export function hasPaneSink(deviceId: string, paneId: string): boolean {
  return defaultRegistry.hasPaneSink(deviceId, paneId);
}

export function onPaneSinkChange(listener: () => void): () => void {
  return defaultRegistry.onPaneSinkChange(listener);
}

export function cleanupDevicePaneState(deviceId: string): void {
  defaultRegistry.cleanupDevicePaneState(deviceId);
}

// 仅测试用
export function resetPaneSinkRegistryForTest(): void {
  defaultRegistry.reset();
}
