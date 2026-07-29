# 执行结果(2026-07-29)

## 改动

1. **gateway `pane-stream-parser`**:clipboard 回调层加相邻重复抑制——相同文本且间隔
   <500ms 只透传一次(`CLIPBOARD_DEDUP_WINDOW_MS`),覆盖「裸 OSC52 + tmux passthrough
   包裹版」背靠背重复(Claude Code 等 CLI 的复制形态);不同内容不受抑制。
2. **stores `tmux.ts`**:复制成功 toast 改用新 key `terminal.copiedPreview`,显示复制
   内容预览(`clipboardToastPreview`:空白折叠为单个空格、按 code point 截断 40 字加省略号);
   `terminal.copied` 保留不动。
3. **i18n 三语** locale 加 `terminal.copiedPreview`,`bun run build:i18n` 重建生成物。

## 验证

- gateway parser 测试 43/43(新增去重两用例:同内容两形态只透传一次、不同内容不抑制);
- stores 测试 57/57;shared i18n 测试 2/2。

## 备注

- 前端消费方(webapp / 下游 App)无需改动,toast 文案变化即全端生效。
