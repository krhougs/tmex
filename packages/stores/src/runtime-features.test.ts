import { describe, expect, mock, test } from 'bun:test';

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
  // @ts-ignore
  globalThis.localStorage = new MemStorage();
}
if (typeof globalThis.window === 'undefined') {
  // @ts-ignore
  globalThis.window = {
    localStorage: globalThis.localStorage,
    location: { origin: 'http://localhost:9663' },
  } as unknown as Window & typeof globalThis;
}

// 与 tmux-host-managed-notifications.test.ts 同一套 mock 前奏：bun test 单进程共享模块注册表，
// 若本文件先真实加载 @tmex/notifications / @tmex/ws-client，会让后续文件的 mock.module 失效。
const notificationsActual = await import('@tmex/notifications');
mock.module('@tmex/notifications', () => ({
  ...notificationsActual,
  playBellSound: mock(() => {}),
}));

const wsActual = await import('@tmex/ws-client');
mock.module('@tmex/ws-client', () => ({
  ...wsActual,
  getBorshClient: () => ({
    send: () => {},
    isReady: () => true,
    onStateChange: () => () => {},
    onMessage: () => () => {},
    onError: () => () => {},
    onLatency: () => () => {},
    onChunkProgress: () => () => {},
    connect: () => {},
  }),
  getSelectStateMachine: () => ({
    dispatch: () => {},
    cleanup: () => {},
    getTransaction: () => null,
    setCallbacks: () => {},
  }),
}));

const { resolveRuntimeCore } = await import('./runtime');

describe('runtime features resolution', () => {
  test('defaults keep every UI switch on (open-source host unchanged)', () => {
    const core = resolveRuntimeCore();
    expect(core.features).toEqual({
      agentUi: true,
      watchUi: true,
      filesUi: true,
      hostManagedNotifications: false,
      hostManagedTheme: false,
    });
  });

  test('empty features object still resolves to defaults', () => {
    const core = resolveRuntimeCore({ features: {} });
    expect(core.features.agentUi).toBe(true);
    expect(core.features.watchUi).toBe(true);
    expect(core.features.filesUi).toBe(true);
  });

  test('watchUi can be switched off independently of agentUi', () => {
    const core = resolveRuntimeCore({ features: { watchUi: false } });
    expect(core.features.watchUi).toBe(false);
    expect(core.features.agentUi).toBe(true);
    expect(core.features.hostManagedNotifications).toBe(false);
  });

  test('agentUi off does not affect watchUi default', () => {
    const core = resolveRuntimeCore({ features: { agentUi: false } });
    expect(core.features.agentUi).toBe(false);
    expect(core.features.watchUi).toBe(true);
  });

  test('filesUi can be switched off independently', () => {
    const core = resolveRuntimeCore({ features: { filesUi: false } });
    expect(core.features.filesUi).toBe(false);
    expect(core.features.agentUi).toBe(true);
    expect(core.features.watchUi).toBe(true);
  });
});
