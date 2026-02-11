# Plan 00：Telegram URL 编码修复与 xterm 宽度优化尝试

时间：2026-02-11

## 目标

1. 修复 Telegram bell 推送链接中的特殊字符编码问题。
2. 基于官方/一手文档给出并落地 xterm 中文/emoji 宽度偏差的可行优化。

## 步骤

1. 修改 gateway 链接生成逻辑，编码所有路径段。
2. 更新相关单测断言。
3. 调研 xterm Unicode 宽度处理方案。
4. 接入 `xterm-addon-unicode11` 并启用 `activeVersion='11'`。
5. 调整终端字体栈并跑构建/测试验证。

## 验收

1. 生成链接中 `@`、`%` 在路径中以 URL 编码形式出现。
2. Gateway 测试通过。
3. FE 构建通过，xterm 宽度策略已生效。
