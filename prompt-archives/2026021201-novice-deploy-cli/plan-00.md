# 计划：tmex 小白部署链路（init/doctor/upgrade/uninstall）

## 背景

当前仓库尚无可发布的 `tmex` CLI 包。现有 `apps/gateway` 与 `apps/fe` 分离运行，且 gateway 仅处理 `/api/*`、`/ws`、`/healthz`，不托管前端静态文件。需要新增对小白友好的部署命令入口，并完成单端口一体化部署形态。

## 注意事项

- 先存档再干活。
- CLI 必须 Node.js 兼容（用于 `npx tmex`）。
- 目标机必须安装 Bun 且版本满足最小要求。
- 部署模式不做应用内循环重启，依赖 systemd/launchd 重启策略。
- Linux 走 `systemd --user`；macOS 走 launchd（用户级 LaunchAgents）。

## 实施步骤

1. 在 `apps/gateway` 抽离可复用 runtime（供 app 包复用），保留 gateway 现有入口兼容。
2. 新建 `packages/app` 包（npm 名称 `tmex`），实现 Node 兼容 CLI：`init`、`doctor`、`upgrade`、`uninstall`。
3. 新增 Bun 运行时入口，组合 gateway runtime 并提供静态文件与 SPA fallback，实现单端口服务。
4. 新增构建流程：构建 FE dist 并打包进 app 资源目录，构建 CLI/runtime dist。
5. 实现初始化安装：交互与无交互参数、生成 key、写 `app.env`、安装 systemd/launchd。
6. 实现 doctor：一次性输出依赖与环境缺失项。
7. 实现 upgrade：默认升级 latest、支持 `--version`，原地升级与失败回滚。
8. 实现 uninstall：交互确认 + `--yes` 自动化 + `--purge` 全清理。
9. 更新 README 与必要文档说明新 CLI 与约束。
10. 运行构建与关键命令验证，归档结果到 `plan-00-result.md`。

## 验收标准

1. `npx tmex init` 可完成交互安装，生成 app.env 并安装服务。
2. `npx tmex init --no-interactive` 缺关键参数时报错。
3. `npx tmex doctor` 一次性输出缺失依赖与环境问题。
4. `npx tmex upgrade` 默认升级 latest 并保留配置与数据库。
5. `npx tmex uninstall` 支持交互确认与自动化模式。
6. 部署模式下不做应用内循环，进程退出由 systemd/launchd 重启。
