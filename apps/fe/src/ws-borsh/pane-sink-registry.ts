// per-pane 输出/历史分发注册表（分屏多 Terminal 实例的路由核心）
//
// 每个 Terminal 实例挂载时以 (deviceId, paneId) 注册一个 sink，卸载时注销。
// 选择状态机与 store 的消息处理统一通过本模块把字节流路由到对应实例：
// - sink 未注册时缓冲有限量输出（Terminal 挂载瞬间的竞态），注册时重放；
// - fetch-history gate：非焦点 pane 主动拉取首屏时，先缓冲 live 输出，
//   history 应用后再 flush，保证内容顺序（带超时兜底放行）。

export interface PaneSink {
  onReset(): void;
  onApplyHistory(data: string, alternateScreen: boolean): void;
  onOutput(data: Uint8Array): void;
}

interface PendingPaneState {
  outputs: Uint8Array[];
  reset: boolean;
  history: { data: string; alternateScreen: boolean } | null;
}

interface HistoryGate {
  token: Uint8Array;
  buffer: Uint8Array[];
  timer: ReturnType<typeof setTimeout>;
}

const MAX_PENDING_OUTPUTS = 1000;
const HISTORY_GATE_TIMEOUT_MS = 3000;

const sinks = new Map<string, PaneSink>();
const pending = new Map<string, PendingPaneState>();
const historyGates = new Map<string, HistoryGate>();

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

function getPending(key: string): PendingPaneState {
  let state = pending.get(key);
  if (!state) {
    state = { outputs: [], reset: false, history: null };
    pending.set(key, state);
  }
  return state;
}

export function registerPaneSink(deviceId: string, paneId: string, sink: PaneSink): () => void {
  const key = paneKey(deviceId, paneId);
  sinks.set(key, sink);

  const state = pending.get(key);
  if (state) {
    pending.delete(key);
    if (state.reset) {
      sink.onReset();
    }
    if (state.history) {
      sink.onApplyHistory(state.history.data, state.history.alternateScreen);
    }
    for (const data of state.outputs) {
      sink.onOutput(data);
    }
  }

  return () => {
    if (sinks.get(key) === sink) {
      sinks.delete(key);
    }
  };
}

export function dispatchPaneReset(deviceId: string, paneId: string): void {
  const key = paneKey(deviceId, paneId);
  const sink = sinks.get(key);
  if (sink) {
    sink.onReset();
    return;
  }
  const state = getPending(key);
  state.reset = true;
  state.outputs = [];
  state.history = null;
}

export function dispatchPaneApplyHistory(
  deviceId: string,
  paneId: string,
  data: string,
  alternateScreen: boolean
): void {
  const key = paneKey(deviceId, paneId);
  const sink = sinks.get(key);
  if (sink) {
    sink.onApplyHistory(data, alternateScreen);
    return;
  }
  getPending(key).history = { data, alternateScreen };
}

export function dispatchPaneOutput(deviceId: string, paneId: string, data: Uint8Array): void {
  const key = paneKey(deviceId, paneId);

  const gate = historyGates.get(key);
  if (gate) {
    if (gate.buffer.length >= MAX_PENDING_OUTPUTS) {
      gate.buffer.shift();
    }
    gate.buffer.push(new Uint8Array(data));
    return;
  }

  const sink = sinks.get(key);
  if (sink) {
    sink.onOutput(data);
    return;
  }

  const state = getPending(key);
  if (state.outputs.length >= MAX_PENDING_OUTPUTS) {
    state.outputs.shift();
  }
  state.outputs.push(new Uint8Array(data));
}

// 开始 fetch-history 门控：此后该 pane 的 live 输出被缓冲，直到
// dispatchPaneHistory 命中 token 或超时兜底放行
export function beginPaneHistoryGate(deviceId: string, paneId: string, token: Uint8Array): void {
  const key = paneKey(deviceId, paneId);
  closePaneHistoryGate(key, { flush: true });

  const timer = setTimeout(() => {
    console.warn(`[pane-sink] history gate timeout on ${key}, releasing buffered output`);
    closePaneHistoryGate(key, { flush: true });
  }, HISTORY_GATE_TIMEOUT_MS);

  historyGates.set(key, { token: new Uint8Array(token), buffer: [], timer });
}

// KIND_TERM_HISTORY 到达时先尝试本函数；token 命中 gate 才消费（返回 true），
// 否则返回 false 交由选择状态机处理（select 路径）
export function dispatchPaneHistory(
  deviceId: string,
  paneId: string,
  token: Uint8Array,
  data: string,
  alternateScreen: boolean
): boolean {
  const key = paneKey(deviceId, paneId);
  const gate = historyGates.get(key);
  if (!gate || !tokensEqual(gate.token, token)) {
    return false;
  }

  clearTimeout(gate.timer);
  historyGates.delete(key);

  dispatchPaneReset(deviceId, paneId);
  dispatchPaneApplyHistory(deviceId, paneId, data, alternateScreen);
  for (const buffered of gate.buffer) {
    dispatchPaneOutput(deviceId, paneId, buffered);
  }
  return true;
}

function closePaneHistoryGate(key: string, opts: { flush: boolean }): void {
  const gate = historyGates.get(key);
  if (!gate) return;
  clearTimeout(gate.timer);
  historyGates.delete(key);
  if (opts.flush) {
    const [deviceId, paneId] = splitPaneKey(key);
    for (const buffered of gate.buffer) {
      dispatchPaneOutput(deviceId, paneId, buffered);
    }
  }
}

function splitPaneKey(key: string): [string, string] {
  const idx = key.lastIndexOf(':');
  return [key.slice(0, idx), key.slice(idx + 1)];
}

export function hasPaneSink(deviceId: string, paneId: string): boolean {
  return sinks.has(paneKey(deviceId, paneId));
}

// device 断开/切换时清理该 device 的所有 pending/gate（sink 由组件卸载自行注销）
export function cleanupDevicePaneState(deviceId: string): void {
  const prefix = `${deviceId}:`;
  for (const key of pending.keys()) {
    if (key.startsWith(prefix)) {
      pending.delete(key);
    }
  }
  for (const key of historyGates.keys()) {
    if (key.startsWith(prefix)) {
      closePaneHistoryGate(key, { flush: false });
    }
  }
}

// 仅测试用
export function resetPaneSinkRegistryForTest(): void {
  sinks.clear();
  pending.clear();
  for (const key of historyGates.keys()) {
    closePaneHistoryGate(key, { flush: false });
  }
}
