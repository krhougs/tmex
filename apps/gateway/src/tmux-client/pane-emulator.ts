// Per-pane headless 终端模拟器 + 引用计数注册表（镜像 runtime-registry 的复用/释放模式）。
// 作用：把某 pane 的实时字节流喂进 headless ghostty 维护渲染网格，并向工具层（read_screen /
// run_command）提供：渲染态文本、alternate 屏判定、字节/OSC133 标记的 tap。
//
// 防内存泄漏（一等约束）：
// - wasm bindings 全局单例；每 pane 仅一个 ghostty 句柄，按 deviceId:paneId 复用，绝不每次新建。
// - 句柄/流订阅在引用计数归零或显式 shutdown 时 free + unsubscribe（幂等）。
// - bounded scrollback + run_command 输出缓冲硬上限 + 池上限（LRU 驱逐 refCount=0 的旧实例）。

import { HeadlessTerminal } from 'ghostty-terminal/headless';
import type { PaneInfo } from './capture-history';
import type { PromptMarker } from './pane-stream-parser';

export interface EmulatorStreamListener {
  onTerminalOutput?: (paneId: string, data: Uint8Array) => void;
  onPromptMarker?: (paneId: string, marker: PromptMarker) => void;
  onClose?: () => void;
}

/** 模拟器所需的流/采样能力。DeviceSessionRuntime 结构上满足。 */
export interface EmulatorStreamSource {
  subscribe(listener: EmulatorStreamListener): () => void;
  capturePaneText(paneId: string, opts?: { historyLines?: number }): Promise<string>;
  getPaneInfo(paneId: string): Promise<PaneInfo>;
}

export interface PaneEmulatorTap {
  onBytes?: (data: Uint8Array) => void;
  onMarker?: (marker: PromptMarker) => void;
}

const DEFAULT_SCROLLBACK = 5000;

export class PaneEmulator {
  private readonly byteSubs = new Set<(data: Uint8Array) => void>();
  private readonly markerSubs = new Set<(marker: PromptMarker) => void>();
  private unsubscribe: (() => void) | null = null;
  private disposed = false;
  /** 最近一次工具使用时间，供 idle 驱逐参考（毫秒，注入避免直接用 Date.now） */
  lastUsedAt = 0;

  private constructor(
    readonly paneId: string,
    private readonly terminal: HeadlessTerminal
  ) {}

  static async create(
    paneId: string,
    source: EmulatorStreamSource,
    opts?: { scrollback?: number }
  ): Promise<PaneEmulator> {
    const info = await source.getPaneInfo(paneId).catch(() => null);
    const cols = info?.cols && info.cols > 0 ? info.cols : 80;
    const rows = info?.rows && info.rows > 0 ? info.rows : 24;
    const terminal = await HeadlessTerminal.create({
      cols,
      rows,
      scrollback: opts?.scrollback ?? DEFAULT_SCROLLBACK,
    });
    const emulator = new PaneEmulator(paneId, terminal);

    // 先 seed 当前可见屏（纯文本），再订阅实时增量，避免漏接/重复。
    const seed = await source.capturePaneText(paneId, { historyLines: 0 }).catch(() => '');
    if (seed) {
      terminal.write(`${seed.replace(/\r?\n/g, '\r\n')}\r\n`);
    }
    emulator.unsubscribe = source.subscribe({
      onTerminalOutput: (pid, data) => {
        if (pid === paneId) {
          emulator.feed(data);
        }
      },
      onPromptMarker: (pid, marker) => {
        if (pid === paneId) {
          emulator.emitMarker(marker);
        }
      },
    });
    return emulator;
  }

  private feed(data: Uint8Array): void {
    if (this.disposed) {
      return;
    }
    this.terminal.write(data);
    for (const cb of this.byteSubs) {
      cb(data);
    }
  }

  private emitMarker(marker: PromptMarker): void {
    if (this.disposed) {
      return;
    }
    for (const cb of this.markerSubs) {
      cb(marker);
    }
  }

  /** 当前可见屏渲染态纯文本。 */
  render(): string {
    return this.terminal.render();
  }

  isAlternateScreen(): boolean {
    return this.terminal.isAlternateScreen();
  }

  size(): { cols: number; rows: number } {
    return this.terminal.size();
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  /** 订阅字节/标记（run_command 用）；返回退订函数。 */
  tap(tap: PaneEmulatorTap): () => void {
    if (tap.onBytes) {
      this.byteSubs.add(tap.onBytes);
    }
    if (tap.onMarker) {
      this.markerSubs.add(tap.onMarker);
    }
    return () => {
      if (tap.onBytes) {
        this.byteSubs.delete(tap.onBytes);
      }
      if (tap.onMarker) {
        this.markerSubs.delete(tap.onMarker);
      }
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.byteSubs.clear();
    this.markerSubs.clear();
    this.terminal.free();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

interface RegistryEntry {
  refCount: number;
  promise: Promise<PaneEmulator>;
  emulator: PaneEmulator | null;
}

export interface PaneEmulatorRegistryOptions {
  /** 池上限，超出时驱逐 refCount=0 的最久未用实例 */
  maxEntries?: number;
  scrollback?: number;
}

export class PaneEmulatorRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly maxEntries: number;
  private readonly scrollback: number;
  private clock = 0;

  constructor(options: PaneEmulatorRegistryOptions = {}) {
    this.maxEntries = options.maxEntries ?? 32;
    this.scrollback = options.scrollback ?? DEFAULT_SCROLLBACK;
  }

  private key(deviceId: string, paneId: string): string {
    return `${deviceId}:${paneId}`;
  }

  acquire(deviceId: string, paneId: string, source: EmulatorStreamSource): Promise<PaneEmulator> {
    const key = this.key(deviceId, paneId);
    const existing = this.entries.get(key);
    if (existing && !existing.emulator?.isDisposed) {
      existing.refCount += 1;
      if (existing.emulator) {
        existing.emulator.lastUsedAt = ++this.clock;
      }
      return existing.promise;
    }
    if (existing) {
      this.entries.delete(key);
    }

    const entry: RegistryEntry = {
      refCount: 1,
      emulator: null,
      promise: PaneEmulator.create(paneId, source, { scrollback: this.scrollback }).then(
        (emulator) => {
          entry.emulator = emulator;
          emulator.lastUsedAt = ++this.clock;
          return emulator;
        }
      ),
    };
    entry.promise = entry.promise.catch((error) => {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key);
      }
      throw error;
    });
    this.entries.set(key, entry);
    this.evictIfNeeded();
    return entry.promise;
  }

  async release(deviceId: string, paneId: string): Promise<void> {
    const key = this.key(deviceId, paneId);
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    entry.refCount -= 1;
    if (entry.refCount > 0) {
      return;
    }
    this.entries.delete(key);
    const emulator = entry.emulator ?? (await entry.promise.catch(() => null));
    emulator?.dispose();
  }

  /** pane 关闭/runtime 断开时强制销毁（忽略 refCount）。 */
  async destroy(deviceId: string, paneId: string): Promise<void> {
    const key = this.key(deviceId, paneId);
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    this.entries.delete(key);
    const emulator = entry.emulator ?? (await entry.promise.catch(() => null));
    emulator?.dispose();
  }

  async shutdownAll(): Promise<void> {
    const entries = Array.from(this.entries.values());
    this.entries.clear();
    await Promise.all(
      entries.map(async (entry) => {
        const emulator = entry.emulator ?? (await entry.promise.catch(() => null));
        emulator?.dispose();
      })
    );
  }

  get size(): number {
    return this.entries.size;
  }

  // 池满时驱逐 refCount=0 且最久未用的实例（已 free，render 不再可用，下次 acquire 重建）。
  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      let victimKey: string | null = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (entry.refCount <= 0 && entry.emulator && entry.emulator.lastUsedAt < oldest) {
          oldest = entry.emulator.lastUsedAt;
          victimKey = key;
        }
      }
      if (!victimKey) {
        break; // 没有可驱逐的空闲实例
      }
      const victim = this.entries.get(victimKey);
      this.entries.delete(victimKey);
      victim?.emulator?.dispose();
    }
  }
}
