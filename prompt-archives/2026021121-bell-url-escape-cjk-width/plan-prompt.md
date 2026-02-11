# Prompt Archive

## 用户请求

尝试解决问题：

1. TG 推送 URL 中的 `@` 和 `%` 没有被正确 escape。
2. xterm 中 emoji 和中文字体看起来比终端 App 略宽，希望先搜索并尝试解决。

## 处理思路

1. 对 Telegram 推送中 pane 直达链接做完整路径段编码（deviceId/windowId/paneId）。
2. 对 bell 上下文中的 paneUrl 同步做一致编码，避免不同链路 URL 形态不一致。
3. 调研并引入 `xterm-addon-unicode11`（与当前 `xterm@5` 兼容）并启用 Unicode 11 宽度规则。
4. 调整 xterm `fontFamily`，优先单宽字体与 CJK mono fallback，降低中英文和 emoji 宽度偏差。
