# 计划：数据库复制后启动失败与 journald 可观测性修复

## 目标
1. 启动失败时给出明确、可定位的错误上下文（哪类密文、哪个对象）。
2. systemd/journalctl 中统一可见运行日志（stdout/stderr）。
3. 提供数据库复制场景的排障说明（保留数据、人工修复）。

## 实施步骤
1. 在 gateway 侧增加解密错误包装（识别 `OperationError`），输出结构化上下文并继续严格失败。
2. 在 systemd unit 模板中显式追加 `SyslogIdentifier`、`StandardOutput=journal`、`StandardError=journal`。
3. 新增/更新测试：
   - systemd unit 文本断言新增 journald 配置。
   - crypto 解密错误包装单测。
4. 补充文档：数据库复制后 `TMEX_MASTER_KEY` 不匹配排障步骤与日志查看命令。
5. 运行 `tmex-cli` 测试与构建，并做现场服务重启验证。
