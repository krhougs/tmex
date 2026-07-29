# Prompt 存档:OSC52 剪贴板重复抑制 + 复制成功 Toast 显示内容预览

## 背景

部分 CLI(如 Claude Code)在 tmux 内触发复制时,会把同一内容以「裸 OSC52 + DCS
passthrough 包裹版」两份背靠背写入 pane 输出流。gateway 的 `pane-stream-parser`
对两种形态都解析并各触发一次 `onClipboardWrite`(包裹版解开后内层重新走同一解析,
测试用例 `tmux passthrough wrapped OSC 52` 即断言此行为),回调层无去重 →
下游收到两个剪贴板事件,前端弹两次「已复制到剪贴板」。

## 用户需求(2026-07-29,转述)

1. 在 gateway parser 的 clipboard 回调层做基础重复抑制;
2. 复制成功 Toast 显示复制的内容(注意长度截断)。

## 设计要点

- 去重:parser 实例内记录上次 write 的文本与时刻,相同文本且间隔 <500ms 跳过;
  不同内容不受抑制,不影响用户快速连续复制不同内容。
- Toast:`stores/tmux.ts` clipboard-write 分支改用新 key `terminal.copiedPreview`
  (插值 `{{preview}}`),预览折叠空白、按 code point 截断(40)加省略号;
  `terminal.copied` 保留不动(避免其他引用面语义漂移)。
- i18n 三语 locale 源改动后必须 `bun run build:i18n` 重建 resources.ts(生成文件禁手改)。
