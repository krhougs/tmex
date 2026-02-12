# Prompt Archive

## 用户需求

1. 改进 `dev-supervisor.sh`：
   - 重启 gateway 的过程中应该杀掉旧的 `ssh-agent` 再启动新的。
   - `ssh-agent` 意外死亡应该触发重启 gateway。
   - 首次启动前端前应等待 gateway 启动。
2. 补充要求：`run-with-ssh-agent.sh` 中的逻辑直接写进 `dev-supervisor.sh`。
3. 执行指令：`Implement the plan.`

## 约束与偏好

- 首次前端等待策略：超时后继续。
- `apps/gateway/scripts/run-with-ssh-agent.sh` 保留不改，仅改 `dev-supervisor.sh`。
