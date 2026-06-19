// 把 toast / 浏览器通知里的 app 内跳转做成「sidebar device list 点击同款」：
// - pane 路由：先 dispatch tmex:user-initiated-selection（2s 内防自动跟踪覆盖该选择），再走 router SPA 导航（replace）。
// - 其它页面路由（如无 window 时降级的 /devices/:id、将来的 settings 等）：只走 router 导航。
// 一律不再用 window.location.href，避免整页刷新 / 被服务端持久化的 siteUrl 污染 origin（issue #32）。
import { bridgeCloseMobileSidebar, bridgeNavigate } from './flow-bridges';

const PANE_URL_RE = /^\/devices\/([^/]+)\/windows\/([^/]+)\/panes\/([^/]+)$/;

// 服务端构造的 paneUrl 是带 origin 的绝对 URL（${siteUrl}/devices/...，siteUrl 可能是 loopback——正是 issue #32 根因），
// 客户端 buildPaneUrl 则是相对路径。统一抽取 pathname，既能让选择事件命中正则，又确保导航到当前 origin 的同路径。
function toAppPath(url: string): string {
  try {
    const u = new URL(url, window.location.origin);
    return u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}

export function navigateToAppUrl(url: string): void {
  const path = toAppPath(url);
  const match = PANE_URL_RE.exec(path);
  if (match) {
    const [, deviceId, windowId, encodedPaneId] = match;
    // detail 里的 paneId 与 sidebar navigateToPane 保持一致：原始未编码值。
    window.dispatchEvent(
      new CustomEvent('tmex:user-initiated-selection', {
        detail: { deviceId, windowId, paneId: decodeURIComponent(encodedPaneId) },
      })
    );
  }
  bridgeNavigate(path, { replace: true });
  bridgeCloseMobileSidebar();
}
