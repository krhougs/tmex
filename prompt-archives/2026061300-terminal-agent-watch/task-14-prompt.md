# Task 14 — tmex 本地终端不应注入 app.env（安全 + 正确性）

## 背景

接 Task 13。排查 test:live 缺环境变量时牵出一个 tmex 本身的 bug。

## 需求（用户原话）

> tmex 开启的终端环境不应该注入 app.env，注入会严重影响正常其他用户的实际场景运行。

## 根因（已定位）

`apps/gateway/src/tmux/local-shell-path.ts` 的 `buildLocalTmuxEnv(resolvedPath, baseEnv = process.env)` 直接 `{ ...process.env }` 作为基底，被 `local-external-connection.ts` 的 `defaultRun` / `defaultSpawnControlClient` 用于 spawn 所有本地 tmux 命令。其中 `new-session`（首个 tmux 命令）会**启动 tmux 服务端**，服务端继承该 env，于是该服务端下**每个 window/pane 的用户 shell 都继承 gateway 的整个 process.env**。

生产下 gateway 由 `run.sh` source `app.env` 启动，process.env 含全部注入变量：
- `NODE_ENV=production`、`DATABASE_URL`、`GATEWAY_PORT`、`TMEX_FE_DIST_DIR`、`TMEX_MIGRATIONS_DIR` …… 污染用户正常环境（如在 tmex 终端里跑测试会误判生产）。
- **`TMEX_MASTER_KEY`**：加密所有凭证的主密钥被泄露进每个用户终端，`echo $TMEX_MASTER_KEY` 即可读取——安全问题。

SSH 设备路径无此问题：远端 tmux 继承远端 sshd/login 环境，gateway 不向远端转发 env（已核对 ssh-bootstrap / ssh-external-connection 无 env 转发）。

## 注入变量集合（据 config.ts + load-env.ts）

- 前缀 `TMEX_`：全部 tmex 命名空间变量（MASTER_KEY / BASE_URL / SITE_NAME / FE_DIST_DIR / MIGRATIONS_DIR / BIND_HOST / GATEWAY_URL / TMUX_* / SSH_* / *_THROTTLE_* / DEFAULT_LANGUAGE / AGENT_ALLOW_PRIVATE_FETCH ……）
- 非前缀少数：`NODE_ENV`、`DATABASE_URL`、`GATEWAY_PORT`、`FE_PORT`

## 方案

`buildLocalTmuxEnv` 改为从 baseEnv 过滤掉「tmex 注入键」（`TMEX_` 前缀 + 上述非前缀白名单）后再叠加 PATH/locale。denylist 而非 allowlist：只剔除 tmex 自己注入的，保留用户终端需要的一切（HOME/USER/SHELL/TERM/LANG/SSH_AUTH_SOCK/…）。所有本地 tmux spawn 统一走净化后的 env。

## 验收

- `buildLocalTmuxEnv` 单测：tmex 注入键被剔除，用户键保留，PATH/locale 行为不变。
- 既有 local-shell-path / local-external-connection 测试全绿。
- 不动 SSH 路径。
