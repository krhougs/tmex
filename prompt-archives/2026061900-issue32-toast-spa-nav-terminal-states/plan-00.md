# Issue #32 + 终端页面状态修复

两个独立但相邻的前端修复，一并实施：
- **Fix A（issue #32）**：toast / 通知里的 app 内跳转用了 `window.location.href` 整页硬跳转 → 改成「sidebar 同款」SPA 导航。
- **Fix B（顺手修）**：终端页面遇到不存在的 window/pane 直接空白；缺 loading / 重连 的视觉；重连时终端内容被整片卸载看不见 → 补友好「找不到」提示 + loading + 重连状态，且重连时保留可见的已有终端内容。

---

## Context（背景）

Issue #32 现象：服务端来源的 watch push 通知点开跳到 `http://127.0.0.1:9883/`（gateway loopback bind 地址），走域名/反代时点不开。Issue 原修法（服务端校验 `siteUrl` / 从 `Origin`、`X-Forwarded-*` 推导公网 base）被判定为**错误方向**。

正确方向（用户给定）：**根因是前端 toast/通知用了 `window.location.href` 整页硬跳转**——会带绝对 origin、触发整页重载（并连带触发 #31 黑屏）。应当：
1. 切换 window/pane 的跳转 → 复刻 **sidebar device list 点击同款行为**（dispatch `tmex:user-initiated-selection` + React Router SPA 导航）。
2. 跳转到其它页面 → 走 **router 库导航**（`bridgeNavigate`）。

Fix B 是顺带修的相邻体验问题，根因同样在前端渲染门控。

---

## Fix A：toast/通知改 SPA 导航

### 现状（已全仓库扫描，仅 4 处 app 内硬跳转，全是 pane 切换）

| # | 文件 | 行 | 场景 | 现状 |
|---|------|----|------|------|
| 1 | `apps/fe/src/components/watch/watch-events-init.tsx` | 70 | 浏览器 `Notification.onclick`（watch 触发） | `window.location.href = url` |
| 2 | `apps/fe/src/components/watch/watch-events-init.tsx` | 101 | sonner toast action（watch 触发） | `window.location.href = url` |
| 3 | `apps/fe/src/stores/tmux.ts` | 368 | sonner toast action（terminal bell） | `window.location.href = paneUrl` |
| 4 | `apps/fe/src/stores/tmux.ts` | 391 | sonner toast action（terminal notification） | `window.location.href = paneUrl` |

> 范围外：`Terminal.tsx:550` 的 `window.open(_blank)` 是终端点外链开新标签页；`DevicePage.tsx:1189` `window.location.reload()`；`site.ts:10` 读 origin。

### 「sidebar 同款」参考实现

`sidebar-device-list.tsx` 的 `navigateToPane`（L194-210）→ `handleNavigate`（L186-192）：
1. `window.dispatchEvent(new CustomEvent('tmex:user-initiated-selection', { detail: { deviceId, windowId, paneId } }))`——标记用户主动选择，`DevicePage`（L725-741）在 2s TTL（`utils/selectionGuards.ts`）内防止自动跟踪覆盖。**detail 里 `paneId` 是原始未编码值**。
2. `navigate(to, { replace: true })`——SPA 导航，replace 默认 true。
3. 移动端 `setOpenMobile(false)`。

已有基础设施：`apps/fe/src/lib/flow-bridges.ts`（`bridgeNavigate`/`bridgeOpenMobileSidebar`/`setSidebarBridge`，由 `components/flow-bridges.tsx` 挂在 RootLayout 注册）。先例 `lib/rsync-install-flow.ts` 已用 `bridgeNavigate` 跳 pane。

### 改动

**A1. `apps/fe/src/lib/flow-bridges.ts`**：补对称的关闭桥接
```ts
export function bridgeCloseMobileSidebar(): void {
  if (sidebarBridge?.isMobile) sidebarBridge.setOpenMobile(false);
}
```

**A2. 新建 `apps/fe/src/lib/app-navigation.ts`**
```ts
import { bridgeCloseMobileSidebar, bridgeNavigate } from './flow-bridges';

const PANE_URL_RE = /^\/devices\/([^/]+)\/windows\/([^/]+)\/panes\/([^/]+)$/;

// toast/通知里的 app 内跳转做成「sidebar 点击同款」：
// - pane 路由：先 dispatch user-initiated-selection（2s 内防自动跟踪覆盖），再 SPA 导航（replace）。
// - 其它页面路由（如 /devices/:id 降级、将来的 settings）：只走 router 导航。
// 一律不再用 window.location.href，避免整页刷新 / 被服务端 siteUrl 污染 origin。
export function navigateToAppUrl(url: string): void {
  const match = PANE_URL_RE.exec(url);
  if (match) {
    const [, deviceId, windowId, encodedPaneId] = match;
    window.dispatchEvent(
      new CustomEvent('tmex:user-initiated-selection', {
        detail: { deviceId, windowId, paneId: decodeURIComponent(encodedPaneId) },
      })
    );
  }
  bridgeNavigate(url, { replace: true });
  bridgeCloseMobileSidebar();
}
```
要点：detail 里 `paneId` 用 `decodeURIComponent` 还原，与 sidebar dispatch 完全一致；`replace: true` 对齐 sidebar；非 pane URL 不 dispatch 选择事件，仅 `bridgeNavigate`（满足「跳其它页面走 router」）。

**A3. 替换 4 处硬跳转**（顶部 import `navigateToAppUrl`）
- `watch-events-init.tsx` L70：`window.focus(); navigateToAppUrl(url);`（保留 `window.focus()`）。
- `watch-events-init.tsx` L101：`navigateToAppUrl(url);`。
- `stores/tmux.ts` L368 / L391：`navigateToAppUrl(paneUrl);`。

> tmux.ts 的 `paneUrl` 是服务端 event payload 现成的相对路径，与 issue 报告的 `siteUrl` 是两套来源，无需碰服务端。

---

## Fix B：终端页面 not-found / loading / 重连状态

### 根因（已读 `DevicePage.tsx` 全文 + `stores/tmux.ts` 状态机）

1. **找不到 window/pane → 空白**：`invalidSelectionMessage`（L177-181）算出来了但**从未渲染**，且用的是泛化的 `wsError.checkGateway`。render 门控是 `deviceConnected && resolvedPaneId`（L906）——URL 带 paneId 时，哪怕该 pane/window 在 snapshot 里不存在，照样挂 `<TerminalComponent isSelectionInvalid={true}>` → 空白且无提示。
2. **重连时内容消失**：同一门控 `deviceConnected && resolvedPaneId`，重连瞬间 `deviceConnected` 翻 false → 整个 `<TerminalComponent>` **被卸载**换成「🔌 已断开」空状态 → xterm 实例销毁、已有内容全没。
3. **重连/loading 无视觉**：`showConnecting = !deviceConnected && !deviceError`（L893），重连时若 `deviceError` 为空它能显示，但用的是 `bg-background/85 backdrop-blur-sm` 全屏遮罩——会糊住内容，违背「重连时看得清已有内容」。

### 可复用资源（无需新增 i18n / 不碰生成文件）

- **连接状态真相源** `stores/tmux.ts`：`deviceConnected: Record<id,bool>`、`deviceReconnecting: Record<id,{message,at}>`、`deviceErrors`。重连事件（errorType `reconnecting`）置 `deviceReconnecting`；`reconnected`/`DEVICE_CONNECTED` 清掉它。
- **`components/device-status-badge.tsx`**：`<DeviceStatusBadge deviceId/>` 在 reconnecting → 琥珀色 spinner badge；error → 红色 badge；空闲 → `return null`。直接复用作终端区**非遮挡**重连指示。
- **现成 i18n key（已存在于所有 locale，无需 `build:i18n`）**：`terminal.windowClosed`（"当前窗口已关闭，请在侧边栏重新选择窗口。"）、`terminal.paneClosed`、`terminal.connecting`、`device.disconnected`。重连文案直接取 `deviceReconnecting.message`（store 里现成、DeviceStatusBadge 已这么用）。`Terminal.tsx` 的 `reset()` 只在 SELECT_START 触发（L363-370），重连不重新 dispatch select（`lastDispatchedSelectRef` 同 key 短路），故不清屏——**Terminal.tsx 无需改**。

### 改动（全部在 `apps/fe/src/pages/DevicePage.tsx`）

**B1. 新增 reconnecting selector + 派生标志**（紧邻 `deviceConnected` selector）
```ts
const deviceReconnecting = useTmuxStore((s) => (deviceId ? s.deviceReconnecting?.[deviceId] : undefined));
const isReconnecting = Boolean(deviceReconnecting);
```

**B2. not-found 文案换成友好的现成 key**（L177-181）
```ts
const invalidSelectionMessage = isWindowMissing
  ? t('terminal.windowClosed')
  : isPaneMissing
    ? t('terminal.paneClosed')
    : null;
```

**B3. 重排渲染门控**（替换 L893-987 的 Terminal/空状态块 + `showConnecting` 遮罩），目标三段优先级：
```ts
// 重连也保持 Terminal 挂载，内容不被卸载
const showTerminal = Boolean(resolvedPaneId) && !isSelectionInvalid && (deviceConnected || isReconnecting);
// 已连接、URL 有 pane、但 snapshot 里还没解析出该 pane 且不是 not-found → 仍在加载
const isResolvingSnapshot = deviceConnected && Boolean(resolvedPaneId) && !isSelectionInvalid && !selectedPane;
```
渲染结构：
- `isSelectionInvalid` → **not-found 空状态**：图标 + `invalidSelectionMessage`（windowClosed/paneClosed 文案本身已含「请在侧边栏重新选择」）。可选加一个返回按钮（复用已存在的 `...back` 文案 key）导航到 `snapshotActiveSelection` 或 `/devices`。优先级最高，不再渲染无效 pane 的 Terminal。
- `showTerminal` → `<TerminalComponent/>`，并叠加两个 overlay：
  - **重连指示（非遮挡，保内容可见）**：`isReconnecting` 时，绝对定位顶部居中 + `pointer-events-none` 放 `<DeviceStatusBadge deviceId={deviceId}/>`（琥珀 spinner + message）。不要用 backdrop-blur。
  - **loading**：`isResolvingSnapshot` 时居中 spinner（`terminal.connecting`）——此刻内容本就空白，可用现有居中 spinner 样式。
- 否则 → 现有空状态：`!deviceConnected && !isReconnecting` → 🔌 disconnected；`!windowId` → 📋 no window；其余 → connecting。
- 原 `showConnecting` 全屏 `backdrop-blur` 遮罩仅在「未连接且非重连且无内容」时用；重连一律走非遮挡 badge，保证已有内容可见。

> 设计自洽性：重连时 `deviceConnected=false` → `isResolvingSnapshot=false`（不弹遮挡 spinner），`showTerminal=true`（Terminal 不卸载、旧 buffer 可见）+ 顶部琥珀 badge。首次加载无内容时 `isResolvingSnapshot=true` 弹居中 spinner。pane/window 真不存在时走 not-found。

### Fix B 已知边界（不在本次范围）

- 重连完成后 gateway 冷重建会重发 history，FE `onApplyHistory` 不 reset 直接 write，极端情况下旧 buffer 上可能叠加重复历史——这是 #31 冷重建固有问题，正解是 #31 的 grace-period / snapshot 重放，本次只保证「重连期间内容不消失」。
- 「pane 存在但首段 history 还没到」的 loading 需 Terminal 内部状态，本次只覆盖 DevicePage 层可判定的 `isResolvingSnapshot`；更细的抓取 spinner 归 #31。

---

## 实施前先存档（AGENTS.md：先存档，再干活）

`prompt-archives/` 下建 `2026061900-issue32-toast-spa-nav-and-terminal-states/`，写 `plan-prompt.md`（用户 prompt 存档）+ `plan-00.md`（本计划），完成后补 `plan-00-result.md`。

## 关键文件

- 改：`apps/fe/src/lib/flow-bridges.ts`（加 `bridgeCloseMobileSidebar`）
- 新增：`apps/fe/src/lib/app-navigation.ts` + `app-navigation.test.ts`
- 改：`apps/fe/src/components/watch/watch-events-init.tsx`（L70、L101）
- 改：`apps/fe/src/stores/tmux.ts`（L368、L391）
- 改：`apps/fe/src/pages/DevicePage.tsx`（L177-181 文案、L893-987 渲染门控；新增 reconnecting selector）
- 复用不改：`device-status-badge.tsx`、`sidebar-device-list.tsx`、`Terminal.tsx`、`utils/selectionGuards.ts`、`utils/tmuxUrl.ts`、`components/flow-bridges.tsx`
- 不动：i18n locale / 生成的 `resources.ts`（全部复用现成 key）

## 验收

1. **类型/构建**：`bun run build:fe`（含 `tsc`）通过；`bun run lint` 对改动文件通过（不碰生成文件）。
2. **单测（Fix A）**：新增 `apps/fe/src/lib/app-navigation.test.ts`（bun:test），mock `./flow-bridges` 与 `window.dispatchEvent`，断言：
   - pane URL → dispatch 一次 `tmex:user-initiated-selection`（deviceId/windowId/**解码后**的原始 paneId 正确）+ `bridgeNavigate(url,{replace:true})` 一次 + `bridgeCloseMobileSidebar` 一次；
   - 非 pane URL（`/devices/abc`）→ **不** dispatch 选择事件、仍 `bridgeNavigate` 一次。
   运行 `bun test apps/fe/src/lib/app-navigation.test.ts`。
3. **手动 + 自助视觉验收（仓内临时实例，严禁碰生产 9883）**：按 AGENTS.md 起 dev（显式覆盖 `GATEWAY_PORT`/`TMEX_BIND_HOST`/`TMEX_FE_DIST_DIR` 等被 shell 继承的 app.env 变量，端口 9885/9665）。
   - **Fix A**：触发 terminal bell / watch 规则，点 toast「Open」与浏览器通知 → URL 切到目标 pane、**无整页刷新**（DevTools Network 无 document 重载、终端不冷重建黑屏）、与点 sidebar 同一 pane 行为一致；移动端视口点 toast 后 sidebar Sheet 关闭。
   - **Fix B not-found**：直接访问 `/devices/<真实id>/windows/BOGUS/panes/BOGUS` → 显示友好「窗口已关闭/找不到」提示而非空白（无需后端配合即可复现）。
   - **Fix B 重连**：连一个设备出现内容后，制造重连（如临时断开 gateway 到 tmux 的连接 / SSH 设备断网）→ 终端**已有内容仍可见**、顶部出现琥珀「重连中」badge；恢复后 badge 消失。
   - 按个人记忆「视觉改动自己验收」，用无头浏览器对 not-found / loading / 重连三态截图留证（Playwright e2e 或驱动上述 BOGUS 路由）。

## 风险

- Fix A 跨设备点 toast 时 `tmex:user-initiated-selection` 在 navigate 前同步 dispatch，目标 DevicePage 可能尚未挂载漏接——与 sidebar 现有行为一致（同样先 dispatch 后 navigate），保持 parity，不额外处理。
- Fix A `replace: true` 使 toast 跳转不进浏览历史（与 sidebar 一致）。
- Fix B 在 `KIND_DEVICE_DISCONNECTED`（连接置 false）与 `reconnecting` 事件之间若有极短间隙，`isReconnecting` 尚未置位可能闪一下卸载——属 store 真相先后顺序，间隙通常 sub-frame，可接受。
