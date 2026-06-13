import { describe, expect, test } from 'bun:test';
import type { PaneInfo } from './capture-history';
import {
  type EmulatorStreamListener,
  type EmulatorStreamSource,
  PaneEmulatorRegistry,
} from './pane-emulator';
import type { PromptMarker } from './pane-stream-parser';

const enc = new TextEncoder();

function createFakeSource(seed = '') {
  const listeners = new Set<EmulatorStreamListener>();
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  const source: EmulatorStreamSource = {
    subscribe(listener) {
      subscribeCount += 1;
      listeners.add(listener);
      return () => {
        unsubscribeCount += 1;
        listeners.delete(listener);
      };
    },
    async capturePaneText() {
      return seed;
    },
    async getPaneInfo(): Promise<PaneInfo> {
      return { cols: 80, rows: 24, cursorX: 0, cursorY: 0, alternateScreen: false, currentCommand: 'bash' };
    },
  };
  return {
    source,
    pushBytes: (paneId: string, text: string) => {
      for (const l of listeners) {
        l.onTerminalOutput?.(paneId, enc.encode(text));
      }
    },
    pushMarker: (paneId: string, marker: PromptMarker) => {
      for (const l of listeners) {
        l.onPromptMarker?.(paneId, marker);
      }
    },
    stats: () => ({ subscribeCount, unsubscribeCount, activeListeners: listeners.size }),
  };
}

describe('PaneEmulator + registry', () => {
  test('seed + 实时字节进渲染态', async () => {
    const fake = createFakeSource('initial line');
    const reg = new PaneEmulatorRegistry();
    const emu = await reg.acquire('d1', '%1', fake.source);
    expect(emu.render()).toContain('initial line');
    fake.pushBytes('%1', 'hello\r\nworld\r\n');
    expect(emu.render()).toContain('hello');
    expect(emu.render()).toContain('world');
    await reg.shutdownAll();
  });

  test('只接收本 pane 的字节', async () => {
    const fake = createFakeSource('');
    const reg = new PaneEmulatorRegistry();
    const emu = await reg.acquire('d1', '%1', fake.source);
    fake.pushBytes('%2', 'OTHER_PANE\r\n');
    expect(emu.render()).not.toContain('OTHER_PANE');
    await reg.shutdownAll();
  });

  test('tap 收到字节与 OSC133 标记', async () => {
    const fake = createFakeSource('');
    const reg = new PaneEmulatorRegistry();
    const emu = await reg.acquire('d1', '%1', fake.source);
    const bytes: string[] = [];
    const markers: PromptMarker[] = [];
    const dec = new TextDecoder();
    const untap = emu.tap({
      onBytes: (d) => bytes.push(dec.decode(d)),
      onMarker: (m) => markers.push(m),
    });
    fake.pushBytes('%1', 'out');
    fake.pushMarker('%1', { kind: 'D', exitCode: 0, params: ['0', 'tmex=n1'] });
    expect(bytes).toEqual(['out']);
    expect(markers).toEqual([{ kind: 'D', exitCode: 0, params: ['0', 'tmex=n1'] }]);
    untap();
    fake.pushBytes('%1', 'after-untap');
    expect(bytes).toEqual(['out']); // 退订后不再收
    await reg.shutdownAll();
  });

  test('引用计数复用同实例；归零即销毁并退订', async () => {
    const fake = createFakeSource('');
    const reg = new PaneEmulatorRegistry();
    const a = await reg.acquire('d1', '%1', fake.source);
    const b = await reg.acquire('d1', '%1', fake.source);
    expect(a).toBe(b); // 复用
    expect(fake.stats().subscribeCount).toBe(1); // 只订阅一次
    await reg.release('d1', '%1');
    expect(a.isDisposed).toBe(false); // 还有一个持有者
    await reg.release('d1', '%1');
    expect(a.isDisposed).toBe(true); // 归零销毁
    expect(fake.stats().unsubscribeCount).toBe(1);
    expect(fake.stats().activeListeners).toBe(0); // 无悬挂监听器
    expect(reg.size).toBe(0);
  });

  test('destroy 忽略 refCount 强制销毁', async () => {
    const fake = createFakeSource('');
    const reg = new PaneEmulatorRegistry();
    const emu = await reg.acquire('d1', '%1', fake.source);
    await reg.acquire('d1', '%1', fake.source); // refCount=2
    await reg.destroy('d1', '%1');
    expect(emu.isDisposed).toBe(true);
    expect(reg.size).toBe(0);
    expect(fake.stats().activeListeners).toBe(0);
  });

  test('池上限驱逐空闲实例', async () => {
    const fake = createFakeSource('');
    const reg = new PaneEmulatorRegistry({ maxEntries: 2 });
    const e1 = await reg.acquire('d1', '%1', fake.source);
    await reg.release('d1', '%1'); // refCount=0，可驱逐
    await reg.acquire('d1', '%2', fake.source);
    await reg.acquire('d1', '%3', fake.source); // 触发驱逐 %1
    expect(e1.isDisposed).toBe(true);
    expect(reg.size).toBeLessThanOrEqual(2);
    await reg.shutdownAll();
  });

  test('shutdownAll 全部销毁 + 退订', async () => {
    const fake = createFakeSource('');
    const reg = new PaneEmulatorRegistry();
    const e1 = await reg.acquire('d1', '%1', fake.source);
    const e2 = await reg.acquire('d1', '%2', fake.source);
    await reg.shutdownAll();
    expect(e1.isDisposed).toBe(true);
    expect(e2.isDisposed).toBe(true);
    expect(reg.size).toBe(0);
    expect(fake.stats().activeListeners).toBe(0);
  });
});
