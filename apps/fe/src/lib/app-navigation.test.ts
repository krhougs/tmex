import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { navigateToAppUrl } from './app-navigation';
import { setNavigateBridge, setSidebarBridge } from './flow-bridges';

// bun 测试环境无 DOM：用最小 window 桩捕获 dispatch 的 CustomEvent（CustomEvent 是 Bun 内建全局）。
// 导航/侧边栏走 flow-bridges 公共注册接口注入 spy，无需 mock 模块。

let dispatched: CustomEvent[] = [];
let navCalls: Array<{ to: string; opts?: { replace?: boolean } }> = [];
let sidebarCloseCalls: boolean[] = [];
let isMobile = true;

beforeEach(() => {
  dispatched = [];
  navCalls = [];
  sidebarCloseCalls = [];
  isMobile = true;
  (
    globalThis as unknown as {
      window: { dispatchEvent: (e: Event) => boolean; location: { origin: string } };
    }
  ).window = {
    dispatchEvent: (e: Event) => {
      dispatched.push(e as CustomEvent);
      return true;
    },
    location: { origin: 'https://tmex.test' },
  };
  setNavigateBridge((to, opts) => {
    navCalls.push({ to, opts });
  });
  setSidebarBridge({
    get isMobile() {
      return isMobile;
    },
    setOpenMobile: (open: boolean) => {
      if (!open) sidebarCloseCalls.push(open);
    },
  });
});

afterEach(() => {
  setNavigateBridge(null);
  setSidebarBridge(null);
  (globalThis as unknown as { window?: unknown }).window = undefined;
});

describe('navigateToAppUrl', () => {
  test('pane 路由：dispatch user-initiated-selection（解码后的原始 paneId）+ SPA 导航(replace) + 关移动端 sidebar', () => {
    // %251 是 encodeURIComponent('%1') 的结果，解码回原始 tmux pane id '%1'
    navigateToAppUrl('/devices/dev1/windows/win2/panes/%251');

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].type).toBe('tmex:user-initiated-selection');
    expect(dispatched[0].detail).toEqual({ deviceId: 'dev1', windowId: 'win2', paneId: '%1' });

    expect(navCalls).toEqual([
      { to: '/devices/dev1/windows/win2/panes/%251', opts: { replace: true } },
    ]);
    expect(sidebarCloseCalls).toEqual([false]);
  });

  test('非 pane 路由（降级 /devices/:id）：不 dispatch 选择事件，仍走 router 导航(replace) + 关 sidebar', () => {
    navigateToAppUrl('/devices/dev1');

    expect(dispatched).toHaveLength(0);
    expect(navCalls).toEqual([{ to: '/devices/dev1', opts: { replace: true } }]);
    expect(sidebarCloseCalls).toEqual([false]);
  });

  test('非移动端：pane 路由仍 dispatch + 导航，但不触发关闭 sidebar', () => {
    isMobile = false;
    navigateToAppUrl('/devices/dev1/windows/win2/panes/p3');

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].detail).toEqual({ deviceId: 'dev1', windowId: 'win2', paneId: 'p3' });
    expect(navCalls).toEqual([
      { to: '/devices/dev1/windows/win2/panes/p3', opts: { replace: true } },
    ]);
    expect(sidebarCloseCalls).toEqual([]);
  });

  test('服务端绝对 URL（带 origin / loopback siteUrl）：抽 pathname 后仍 dispatch + 导航到当前 origin 的同路径', () => {
    // tmux bell/notification 的 paneUrl 来自服务端，形如 `${siteUrl}/devices/...`，siteUrl 可能是 loopback。
    navigateToAppUrl('http://127.0.0.1:9883/devices/dev1/windows/win2/panes/%251');

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].detail).toEqual({ deviceId: 'dev1', windowId: 'win2', paneId: '%1' });
    // 导航目标是 pathname（去掉 loopback origin），避免整页跳到 127.0.0.1。
    expect(navCalls).toEqual([
      { to: '/devices/dev1/windows/win2/panes/%251', opts: { replace: true } },
    ]);
  });

  test('尾斜杠 URL 不视为 pane 路由：不 dispatch，仅 router 导航', () => {
    navigateToAppUrl('/devices/dev1/windows/win2/panes/p1/');

    expect(dispatched).toHaveLength(0);
    expect(navCalls).toEqual([
      { to: '/devices/dev1/windows/win2/panes/p1/', opts: { replace: true } },
    ]);
  });

  test('其它页面路由（/settings）：不 dispatch，仅走 router', () => {
    navigateToAppUrl('/settings');

    expect(dispatched).toHaveLength(0);
    expect(navCalls).toEqual([{ to: '/settings', opts: { replace: true } }]);
  });
});
