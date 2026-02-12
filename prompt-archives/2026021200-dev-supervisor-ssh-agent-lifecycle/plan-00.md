# 计划：dev-supervisor 内联 SSH Agent 生命周期管理

## 背景

当前 `scripts/dev-supervisor.sh` 仅负责 gateway/frontend 进程拉起与重启，未管理 `ssh-agent` 生命周期。gateway 目前通过 `apps/gateway/scripts/run-with-ssh-agent.sh` 注入 SSH Agent。需求要求在 supervisor 层显式接管：gateway 重启时轮换 agent、agent 异常死亡触发 gateway 重启、首次前端启动前等待 gateway。

## 注意事项

- 先归档再改代码。
- 仅改 `scripts/dev-supervisor.sh` 与必要文档说明，保留 gateway wrapper 供其他入口使用。
- 避免误杀非本脚本管理的 ssh-agent，只处理 supervisor 启动并记录的 PID。

## 实施步骤

1. 在 `scripts/dev-supervisor.sh` 内联 `run-with-ssh-agent.sh` 的 socket 解析与 key 注入逻辑。
2. 增加受管 agent 状态变量与函数（启动/停止/存活检查）。
3. 将 gateway 启动改为统一重启入口：先停旧 gateway，再停旧 agent，启动新 agent，最后启动 gateway。
4. 在主循环中监控 agent 存活；若 agent 异常死亡则触发 gateway 重启。
5. 将首次启动顺序改为：先 gateway，等待 `/healthz`（超时后继续），再启动 frontend。
6. 更新 README，补充 dev-supervisor 行为和 `GATEWAY_WAIT_TIMEOUT_SECONDS`。
7. 运行语法检查与最小验证，记录结果。

## 验收标准

1. gateway 每次重启都伴随受管 agent 轮换。
2. agent 意外死亡后 gateway 被自动重启。
3. frontend 首次启动前执行 gateway 就绪等待（默认 30s 超时继续）。
4. supervisor 退出时受管 agent 被清理。
