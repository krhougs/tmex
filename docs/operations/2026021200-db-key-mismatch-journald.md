# 数据库复制后启动失败与 journald 排障说明

## 背景
在 tmex 部署目录中直接替换数据库文件（例如复制测试环境的 `tmex.db`）后，服务可能启动失败并持续重启。

常见表现：
- `systemctl --user status tmex.service` 显示 `activating (auto-restart)`。
- `journalctl --user -u tmex.service` 出现 `OperationError` 或解密失败相关日志。

## 根因
tmex 会对部分敏感字段做加密存储（如 Telegram Bot Token、SSH 密码/私钥）。
如果数据库中的密文与当前 `app.env` 里的 `TMEX_MASTER_KEY` 不匹配，启动阶段解密会失败，服务按“严格失败”策略退出。

## 快速排查
1. 查看服务状态：
```bash
systemctl --user status tmex.service -l --no-pager
```
2. 查看最近日志：
```bash
journalctl --user -u tmex.service -n 200 --no-pager
```
3. 连续追踪日志：
```bash
journalctl --user -u tmex.service -f
```
4. 核对当前 key：
```bash
grep '^TMEX_MASTER_KEY=' /home/<user>/.local/share/tmex/app.env
```

## 修复建议（保留数据）
1. 优先使用与该数据库对应的原始 `TMEX_MASTER_KEY`。
2. 若原始 key 不可恢复，则手动重建受影响的密文配置：
- Telegram Bot：重新填写 token。
- SSH 设备认证：重新填写密码/私钥。
3. 修复后重启服务：
```bash
systemctl --user restart tmex.service
```

## 日志可观测性
当前 systemd user unit 已显式配置输出到 journald：
- `SyslogIdentifier=tmex`
- `StandardOutput=journal`
- `StandardError=journal`

因此不需要额外日志文件即可通过 `journalctl` 排障。

## 注意事项
- 不建议跨环境直接拷贝生产/测试数据库，除非同步迁移对应的 `TMEX_MASTER_KEY`。
- 若必须拷库，建议先备份原 `app.env` 和数据库，再执行替换。
