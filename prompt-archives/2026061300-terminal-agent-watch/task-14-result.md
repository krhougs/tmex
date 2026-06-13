# Task 14 结果 — tmex 本地终端不再注入 app.env

## 根因

`apps/gateway/src/tmux/local-shell-path.ts` 的 `buildLocalTmuxEnv` 以 `{...process.env}` 为基底 spawn 本地 tmux（`local-external-connection.ts` 的 `defaultRun`/`defaultSpawnControlClient`）。首个 `new-session` 启动的 tmux 服务端继承该 env，于是其下每个 window/pane 的用户 shell 都继承 gateway 进程的整个 env。生产下含 app.env 注入的 `NODE_ENV=production`、`DATABASE_URL`、各 `TMEX_*` 配置，以及加密主密钥 **`TMEX_MASTER_KEY`**——既污染用户正常环境，又泄露密钥。

## 改动（commit 5ac932d）

`buildLocalTmuxEnv` 改为遍历 baseEnv、剔除「tmex 注入键」后再叠加 PATH/locale：
- `TMEX_` 前缀全部剔除；
- 非前缀白名单 `NODE_ENV` / `DATABASE_URL` / `GATEWAY_PORT` / `FE_PORT` 剔除；
- 保留 `HOME` / `USER` / `SHELL` / `PATH` / `LANG` / `SSH_AUTH_SOCK` 等用户终端所需变量（denylist 而非 allowlist，确保不误删）。

所有本地 tmux spawn 统一走净化后的 env。SSH 设备路径不受影响（远端 tmux 继承远端 sshd 环境，gateway 不转发 env；已核对 ssh-bootstrap/ssh-external-connection 无 env 转发）。

## 验收

- 新增 `buildLocalTmuxEnv` 单测：tmex 注入键（含 `TMEX_MASTER_KEY`）全被剔除，用户键完整保留，PATH/locale 行为不变。
- gateway 全量 `bun test`：433 pass / 0 fail。

## 注意（生效条件）

代码层已修，但只对**修复版常驻服务新拉起的 tmux 服务端**生效。用户当前 shell 若由旧生产服务（≤ 本次发版前）拉起的 tmux 承载，仍带毒；需用户正式发版 + `tmex upgrade` 并重建 tmux 服务端后才彻底干净。已同步更新本机环境坑 memory。
