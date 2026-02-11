# Plan 00：对齐 iTerm2 的历史恢复与尺寸同步策略

时间：2026-02-11

## 背景

在 `2026021104-bidirectional-terminal-resize` 的修复后，用户仍反馈以下问题：

1. 页面刷新后颜色仍会丢失。
2. 浏览器 resize 与“同步尺寸”按钮偶发无效。
3. iTerm2 与浏览器双向尺寸同步不稳定。
4. 新建窗口偶发 1-5 列宽度溢出。

用户要求参考 iTerm2 源码实现方式。已对照 `gnachman/iTerm2` 关键代码路径（`TmuxWindowOpener.m`、`TmuxStateParser.m`、`TmuxController.m`）。

## 注意事项

1. iTerm2 明确将 `aggressive-resize` 视为集成模式不兼容选项，需避免开启。
2. `refresh-client -C` 后应及时触发窗口/面板状态刷新，避免 UI 读到旧尺寸。
3. 历史回放必须保留 ANSI/控制序列，避免中间解析链路吞掉 `\r` 或转义字节。
4. 该仓库当前存在大量并行改动，本次仅改动终端同步与历史回放相关文件。

## 目标

1. 浏览器 `resize` 与“同步尺寸”按钮可稳定驱动 tmux pane 尺寸变化。
2. iTerm2 调整尺寸后，浏览器端 rows/cols 能跟随回传变化。
3. 刷新后历史回放保留 ANSI 颜色信息。
4. 减少新建窗口首帧被旧快照反向覆盖导致的宽度溢出。

## 任务清单

1. 调整网关 tmux 尺寸策略：关闭 `aggressive-resize`。
2. 在网关 `resize-pane` 后增加快照刷新节流，降低旧尺寸滞后。
3. 修复前端本地尺寸上报与远端快照回传的竞争覆盖问题。
4. 修复 tmux 控制解析器对行内 `\r` 的处理，避免历史/TUI 重绘错乱。
5. 增加针对性测试：
   - parser `\r`/CRLF 回归测试；
   - e2e 覆盖“刷新后 term/history 仍包含 ANSI 转义”。
6. 执行构建与定向 e2e 验证并归档结果。
