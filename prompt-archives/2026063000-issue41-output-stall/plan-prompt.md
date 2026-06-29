# Issue #41: 终端输出卡死修复

## 用户报告

> 开一个新的worktree 看一下 https://github.com/krhougs/tmex/issues/41 我也遇到这个问题了，而且我刷新无解，需要重启gateway才好。不要参考issue里的debug，不要被误导

## Issue 摘要

- tmex CLI 0.13.0+，gateway 运行一段时间后所有客户端终端输出同时停止
- 输入正常（keystrokes 到达 pane）
- 刷新页面无法恢复
- 需要重启 gateway 才能恢复
- 常见于 7-15 个 busy pane 持续产出大量输出的场景

## 确认的修复方向

用户确认采用 **stdin 心跳探测** 方案：
- 为控制客户端添加 stdin 写入能力（当前设计为"永不写入"）
- 处理 `%pause` 通知，通过 stdin 发送 continue 命令
- 定期发送心跳命令检测卡死，超时则杀掉重建
- 同时修复 pumpControlStdout 无恢复机制的问题
