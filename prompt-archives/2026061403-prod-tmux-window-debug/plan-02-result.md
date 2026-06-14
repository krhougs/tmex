# plan-02 执行结果

## 背景

本轮修复针对生产环境中 tmux snapshot 下发复合窗口 ID（例如 `@0_0_bash_1`）的问题。用户补充的实测结论表明：`LANG=C` 下 tmux 3.4 会把 format 中的字面 TAB 渲染为 `_`，导致本地 snapshot 的 `\t` 分隔解析失败。用户要求直接在 `main` 分支修复，并按项目规范善用 subagent。

## 实施摘要

已在 `main` 工作区完成修复，未提交。

- 新增 `apps/gateway/src/tmux-client/snapshot-format.ts`，集中定义 locale 稳定的 `|` 分隔符、snapshot 字段切分、tmux ID 正则、严格整数解析和日志截断。
- 本地 tmux snapshot 从 `\t` 改为 `|` 分隔，并复用共享 parser。
- SSH snapshot 复用同一套 parser，避免 local/SSH 行为漂移。
- local/SSH snapshot 解析改为 fail-closed：非法 session/window/pane 行被丢弃；session 无效或无有效 window 时下发 `session: null`，不再让半坏数据流向前端。
- `selectWindow()` 对 target missing 改为 benign recovery，与 `closeWindow` 对齐。
- WS 入站 `select-window`/`select-pane` 增加格式校验和当前 snapshot 成员校验；非法或过期目标只请求刷新 snapshot，不执行 tmux 写命令，也不提前改 `selectedPanes`。
- `buildLocalTmuxEnv()` 对非 UTF-8 或缺失 locale 强制设置 `LC_ALL=C.UTF-8`，同时保留已有 UTF-8 locale。
- `runTmux` 非 target-missing 错误日志增加 `argv`、`deviceId`、`sessionName` 上下文。

## subagent 使用

- Banach 负责只读审查 tmux snapshot parser、target-missing 行为和测试覆盖。采纳了严格整数解析、SSH 对称覆盖、日志截断等建议。
- Popper 负责只读审查 WS 选择链路和跳转相关状态更新顺序。采纳了“先校验、后写 `selectedPanes` 和启动 switch barrier”的建议。

## 修改文件

- `apps/gateway/src/tmux-client/snapshot-format.ts`
- `apps/gateway/src/tmux-client/snapshot-format.test.ts`
- `apps/gateway/src/tmux-client/local-external-connection.ts`
- `apps/gateway/src/tmux-client/local-external-connection.test.ts`
- `apps/gateway/src/tmux-client/ssh-external-connection.ts`
- `apps/gateway/src/tmux-client/ssh-external-connection.test.ts`
- `apps/gateway/src/tmux/local-shell-path.ts`
- `apps/gateway/src/tmux/local-shell-path.test.ts`
- `apps/gateway/src/ws/index.ts`
- `apps/gateway/src/ws/index.test.ts`

## 验证结果

已通过：

```bash
bun test apps/gateway/src/tmux-client/snapshot-format.test.ts apps/gateway/src/tmux-client/local-external-connection.test.ts apps/gateway/src/tmux-client/ssh-external-connection.test.ts apps/gateway/src/ws/index.test.ts apps/gateway/src/tmux/local-shell-path.test.ts
```

结果：62 pass，0 fail，164 expect() calls。

已通过：

```bash
cd apps/gateway && bun test
```

结果：526 pass，0 fail，1596 expect() calls。

额外尝试：

```bash
bun run test
```

该根级全量测试未形成有效通过结论。shared、cli、ghostty、gateway 阶段已经通过，但进入 `@tmex/fe` Playwright E2E 后出现大量 `EAGAIN: resource temporarily unavailable, posix_spawn '/opt/homebrew/bin/tmux'`，临时 gateway 和 tmux 连接数失控后引发连锁 E2E 失败。随后已清理本轮测试遗留的临时 gateway/Vite 进程组，未触碰生产 tmex 服务。

## 注意事项

- 本轮没有写入、覆盖、重启或 kill 本机生产 tmex 安装目录和常驻服务。
- `~/Library/Application Support/tmex/runtime/server.js` 对应的生产进程未被改动。
- 根级 `bun run test` 的失败原因是前端 E2E 运行时资源耗尽，不是本轮 gateway 单测验证失败；后续若需要根级全量验证，建议在干净环境下以更低并发或拆分 FE E2E 执行。
