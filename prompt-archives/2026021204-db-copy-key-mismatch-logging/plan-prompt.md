# Prompt 存档：数据库复制后启动失败与 journald 可观测性

## 背景
- 用户反馈：将项目根目录测试数据库复制到安装目录后，tmex 服务报错启动失败。
- 用户诉求：
  1. 我把项目根目录的测试数据库复制了过去，然后就报错了
  2. systemd和journalctl中需要可以看到log

## 现场事实
- systemd 状态：`tmex.service` 重启循环，主进程退出码 `1`。
- journalctl 输出：Bun 抛 `OperationError`/`DOMException`，但缺少业务上下文。
- 运行配置：`DATABASE_URL=/home/krhougs/.local/share/tmex/data/tmex.db`。
- 数据库完整性：`PRAGMA integrity_check` 为 `ok`。
- 数据库内容：存在 `telegram_bots` 记录且 `token_enc` 非空，启动阶段会触发解密。
- 推断：复制的数据库密文与当前 `TMEX_MASTER_KEY` 不匹配，`decrypt` 触发 `OperationError`。

## 决策
- 启动策略：严格失败（不降级启动）。
- 日志落点：仅 journald（systemd 中显式配置 StandardOutput/StandardError）。
- 数据策略：保留并人工修复，不自动清库。
