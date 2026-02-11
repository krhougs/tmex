# 执行结果

## 结果概览

- 已修复 SSH Agent 连接失败的核心配置问题。
- 已实现 Gateway 启动后向所有已授权 Telegram chat 推送上线信息。
- 新增并通过相关单元测试。

## 根因结论

1. SSH 连接配置在用户名缺省时固定回退为 `root`，与用户 shell 的实际可登录用户不一致，导致 Agent 认证常见失败。
2. `authMode=agent` 时 `SSH_AUTH_SOCK` 缺失仅静默忽略，错误暴露不及时。
3. Gateway 启动流程未触发任何 Telegram 广播逻辑。

## 主要变更

- 新增 `apps/gateway/src/tmux/ssh-auth.ts`：
  - `resolveSshUsername`：agent/auto 模式优先使用 `USER/LOGNAME`。
  - `resolveSshAgentSocket`：agent 模式要求 `SSH_AUTH_SOCK`，缺失时抛清晰错误。
- 更新 `apps/gateway/src/tmux/connection.ts`：
  - SSH 连接改为使用上述解析函数构建 `username/agent`。
- 更新 `apps/gateway/src/telegram/service.ts`：
  - 新增 `sendGatewayOnlineMessage(siteName)` 广播上线文案。
- 更新 `apps/gateway/src/index.ts`：
  - Gateway 启动时读取站点设置并调用上线广播（失败仅记录日志，不阻塞服务启动）。
- 新增测试：
  - `apps/gateway/src/tmux/ssh-auth.test.ts`
  - `apps/gateway/src/telegram/service.startup.test.ts`

## 验证结果

- 执行：`source ~/.zshrc >/dev/null 2>&1 || true; cd apps/gateway && bun test`
- 结果：`21 pass, 0 fail`

## 额外说明

- 根目录 `bun run lint` 失败来自既有前端与 Playwright 产物格式问题，与本次 Gateway 修复无直接关系。
