# Tokio Gateway 重写实施结果

## 稳定结果

- Gateway 生产实现已收敛为 `tmex-gateway` Rust crate 与同名 standalone binary；核心运行时同时提供 listener-free 的 HTTP/WS IPC 接口，standalone 入口只负责配置、启动编排、监听和静态资源服务。
- HTTP、legacy/canonical Borsh WebSocket、tmux/SSH/终端状态、Agent、Watch、Push、Telegram、微信与通知服务均由 Rust Gateway 组合；旧 TypeScript Gateway 代码仅保留为兼容真源和测试 oracle，不再是 dev、Playwright、Docker、npm 服务或 release 的生产入口。
- npm 包继续使用 `tmex-cli`，保留 `tmex`/`tmex-cli` 双 bin、init/doctor/upgrade/uninstall、install-meta、app.env、服务注册、隐藏升级 handoff 与 rollback。安装服务直接执行当前平台的 `tmex-gateway`。
- Gateway Rust workspace 包含 `tmex-gateway`、`tmex-db`、`tmex-protocol`、`tmex-terminal`，统一 MSRV 为 Rust 1.90.0。该下限来自锁定依赖链 `turso 0.7.2 -> turso_core 0.7.2 -> roaring 0.11.4`，其中 `roaring` 声明 Rust 1.90；Docker builder 与 artifact workflow 同步使用 1.90.0。

## 数据库与迁移闭环

- `apps/gateway/build.rs` 在编译期读取 `drizzle/meta/_journal.json` 与 0000..0017 共 18 份 SQL，严格校验 journal、索引、tag、时间和文件完整性，计算原始 SQL SHA-256，并在 Cargo `OUT_DIR` 生成静态迁移表。
- Gateway runtime 只通过 `include!(concat!(env!("OUT_DIR"), ...))` 使用编译产物；`DatabaseBootstrap` 固定先执行 legacy Drizzle 静态迁移，再执行 Rust Gateway 编译迁移。启动路径不打开 migration 目录。
- Companion 的 `COMPANION_MIGRATIONS` 也是编译期静态表；`EmbeddedDatabaseBootstrap` 在同一 `tmex_db::Database` 上依次执行 Gateway legacy、Gateway Rust、Companion 三组迁移，不依赖运行时 migration 文件。
- 最终兼容审计修正了四处 SeaORM partial-select：存在性查询和 Telegram/微信计数查询均用 `into_tuple` 解码标量，历史非空表不会再因缺失未选择字段而把启动或计数误判为失败。

## 生产构建与包消费

- artifact producer 从 Cargo metadata 确认唯一 binary 名 `tmex-gateway`，只允许 native runner 构建当前 target。workflow 以四个原生 runner 生成 `darwin-arm64`、`darwin-x64`、`linux-arm64`、`linux-x64` 片段，再统一组装。
- package 消费的 manifest 固定为 `schemaVersion: 1`，包含 package/Cargo 同源 `version`，以及每个 target 的相对 `path` 和小写 64 位 SHA-256。组装和安装前均验证 target 完整性、路径不能逃逸、版本一致和内容 checksum。
- package 只复制当前 target 的 binary 到安装布局；SPA 与 terminfo 保留，旧 Gateway JavaScript bundle、Gateway Ghostty parser 资源和 migration materialization 不再进入生产包。`resources/gateway-drizzle` 仅保留旧安装清理/rollback 的路径兼容，不是 runtime 输入。
- `build-artifacts --smoke` 在独立临时工作目录、随机非生产端口和非默认 namespace 中启动产物，并注入绝对路径、可执行且恒失败的 fake tmux；冒烟不会连接真实/default tmux。

## 最终兼容修正

- 旧 local/SSH Gateway 对 session 配置命令使用 best-effort 执行。Rust 曾把包括现代 tmux 已移除的 `default-path` 在内的整批配置升级为启动必需，导致 tmux 3.7b 上 runtime 无法连接。现已恢复为 best-effort：transport 错误仍上抛，命令非零不终止连接；新 session/window/pane 的工作目录继续由既有 `new-session`、`new-window`、`split-window -c` 明确传递。
- 为该边界保留了 `unsupported_best_effort_session_option_does_not_abort_startup` 回归；真实 Playwright Agent 首例也在专用 `TMEX_TMUX_SOCKET=tmex-e2e` 上恢复。
- legacy `TERM_INPUT`/`TERM_PASTE` 现在由 WS session actor 按 wire 顺序等待写入 runtime 的有界命令队列，但不等待实际 tmux 命令完成。这样既保留了旧 `inputTransition` 的 FIFO，也不会在队列瞬时满时丢弃 paste chunk。容量回归会阻塞首条 input、填满 256 项队列，再验证 260 条输入顺序一致且零丢失。
- legacy pane resize 恢复旧 Gateway 的 window 语义：`TMUX_SELECT.size` 与 `TERM_SYNC_SIZE` 先按 pane 解析 owning window，再执行 `resize-window`；显式 `ResizePaneById` 和 canonical direct pane resize 仍执行 `resize-pane`。select、可选初始 resize 与随后 sync resize 通过同一个 runtime actor 的有界队列排队，队列饱和时施加背压而不重排或丢帧。
- 为这条真实回归保留了 `legacy_select_and_sync_resize_stay_fifo_when_the_runtime_queue_is_full`：阻塞第一条 select、填满 256 项队列，再确认 60×18 的 select resize 严格先于 112×35 的 sync resize。

## 验证结果

- Rust 1.90.0：`cargo fmt --all -- --check`、`cargo check --workspace --all-targets --locked`、`cargo test --workspace --all-targets --locked`、`cargo clippy --workspace --all-targets --locked -- -D warnings` 均通过。
- tmux 定向测试：67 项通过；WS 定向测试：44 项通过；`default-path` best-effort、legacy input FIFO，以及 select/sync resize FIFO/饱和回归均通过。
- Gateway `--all-targets`：253 项通过，0 失败；all-targets clippy `-D warnings` 通过。
- migration 定向验证：Gateway 历史非空 partial-select 回归通过；Companion 同库三组编译迁移顺序测试通过。
- TypeScript Gateway oracle：1058 项通过，0 失败。
- `tmex-cli` package：80 项通过，0 失败；本轮复跑的 production-entry/env/artifact contract：17 项通过，0 失败。
- package artifact smoke：本机 `darwin-arm64` Rust binary 在仓库外临时目录启动，`GET /healthz` 返回 200；fake tmux 与独立 namespace 已生效。
- 当前 standalone debug binary 也再次复制到一个不含源码和 migration 文件的全新临时目录：空库启动后 `/healthz` 返回 200，`__drizzle_migrations=18`、`tmex_gateway_migrations=0`、`PRAGMA integrity_check=ok`。
- Playwright 全量在 input FIFO 修正前得到 88 通过、13 失败、3 跳过；其中 mobile 五项、issue45 diagnostic 与 settings-llm 是仓库已记录的陈旧测试，theme/resize 与 selection 也包含已记录的负载敏感基线。该轮额外暴露的 IME 输入顺序问题已修正，随后使用独立数据库和 `tmex-e2e` socket 连续单跑两次均通过，PTY 与 canvas 都得到完整 `你好世界！`。
- single-pane resize 的旧 TS oracle 在严格隔离环境重复 3 次均通过，wire 顺序明确是 `TMUX_SELECT 60×18` 后紧接 `TERM_SYNC_SIZE 112×35`。FIFO 修正后，确定性探针连续 3 次都得到 `112×35 → 60×18 → 112×35`；原始 spec 重复 3 次为 2 通过、1 失败，失败轮产品最终尺寸仍正确为 112×35，但测试在初始 80×24 与稍后的正确 112×35 同步之间取了旧期望值。因此这里记录产品契约闭环，不把原始 Playwright 全量误报为全绿。
- `cargo metadata --locked`、`git diff --check` 通过；Cargo workspace 四个 package 的版本与 Rust 1.90.0 声明一致。

## 验证边界

- 本机只真实构建和运行了当前 `darwin-arm64` target；其他三个 target 由 workflow 的 native runner matrix 定义，本次未声称本地跨平台构建。
- Docker CLI 未作为本机验证前提；已核对官方 `rust:1.90.0-bookworm` 存在 amd64/arm64 manifest，实际镜像构建交给 release/CI 环境。
- 仓库级 Biome 基线仍包含既有格式/前端 lint 诊断，且当前配置会扫描 ignored 的 Cargo `target/`；本次改动涉及的 TypeScript 脚本与契约测试已做定向 Biome 检查。
- 全量 Playwright 不是全绿证据。除已完成产品闭环的 IME 与 single-pane FIFO 外，mobile、issue45、settings、theme/selection 仍包含既有失败或负载敏感基线；focus stale 的浏览器没有发 resize frame，remote echo 也复现为前端 1200 ms self-verify 的计时竞争，未通过改 Rust Gateway 掩盖这些前端契约问题。
