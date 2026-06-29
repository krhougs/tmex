# 0.15.0

_2026-06-29_

## English

### Bug Fixes

- Fix iOS PWA losing WebSocket connection permanently after backgrounding. The client now detects zombie connections via pong timeout and automatically reconnects when the page returns to foreground. (`42c8249`)
- Fix stdin heartbeat and `%pause` handling in control mode; improve pump recovery on unexpected disconnects. (`a208371`)

### Improvements

- Add a floating connection status indicator (bottom-right corner) that shows reconnecting state and provides a manual reconnect button when all retries are exhausted. Replaces the previous unhelpful error toast.
- Display WebSocket latency next to the dark mode toggle in the sidebar. Values >= 150 ms are highlighted in red.

---

## 中文

### 问题修复

- 修复 iOS PWA 后台化后 WebSocket 永久断连的问题。客户端现在通过 pong 超时检测僵尸连接，页面回到前台时自动恢复连接。(`42c8249`)
- 修复控制模式下 stdin 心跳和 `%pause` 处理问题，改善意外断连时的 pump 恢复。(`a208371`)

### 体验优化

- 新增浮动连接状态指示器（右下角），显示重连状态，重试耗尽后提供手动重连按钮。替换了之前不友好的错误 toast。
- 在侧边栏深色模式开关旁显示 WebSocket 延迟，延迟 >= 150 ms 时标红。
