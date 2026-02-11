# 计划：修复 SSH Agent 连接与 Gateway 启动广播

## 背景

- 现象 1：用户在当前 shell 下可直接 `ssh 127.0.0.1` 登录，但 tmex 的 SSH Agent 认证失败。
- 现象 2：Gateway 启动后没有向所有已授权 Telegram chat 推送“上线”信息。

## 注意事项

- 先做根因定位，再实施修复，禁止猜测性改动。
- 按 TDD 执行：先补失败测试，再改生产代码。
- 仅做与本需求直接相关的最小改动，避免引入额外行为变化。

## 执行步骤

1. 定位 `apps/gateway/src/tmux/connection.ts` 的 SSH Agent 认证构造逻辑，确认用户名与 `SSH_AUTH_SOCK` 使用方式。
2. 新增测试覆盖 SSH Agent 用户名/Socket 解析行为（包含缺失 `SSH_AUTH_SOCK` 的报错）。
3. 提取并实现 `ssh-auth` 解析逻辑，接入 SSH 连接配置构建流程。
4. 新增 Gateway 启动消息发送方法测试，覆盖上线文案关键字段。
5. 在 Gateway 启动流程中调用上线广播方法，并加容错保护。
6. 运行 `apps/gateway` 测试确认回归通过，整理结果。
