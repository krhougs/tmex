# 0.13.0

_2026-06-20_

## English

### New

- WeChat notifications: scan a QR code to link your WeChat account and receive tmex notifications (such as command completions and alerts) right inside WeChat. The connection stays alive automatically, and tmex sends you a heads-up when it comes online.

### Improvements

- Faster first load: the app downloads noticeably less when you first open it — especially helpful on slow networks.

### Fixes

- Clicking a notification now jumps to the right place inside tmex instead of reloading the whole page.
- Opening a terminal that no longer exists now shows a clear message instead of a blank screen, with proper loading and reconnecting states — and your existing terminal output stays visible while it reconnects.

---

## 中文

### 新增

- 微信通知：扫码绑定微信账号后，即可直接在微信里收到 tmex 的通知（如命令完成、告警等）。连接会自动保活，tmex 上线时也会给你发来一条提醒。

### 改进

- 首屏加载更快：应用首次打开时需要下载的内容明显减少，弱网环境下尤其明显。

### 修复

- 点击通知现在会正确跳转到 tmex 内对应位置，不再整页刷新。
- 打开已不存在的终端时会给出清晰提示，而不是一片空白，并补全了加载与重连状态——重连时仍能看清已有的终端内容。
