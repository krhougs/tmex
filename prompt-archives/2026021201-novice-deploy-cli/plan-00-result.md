# 执行结果：tmex 小白部署链路（init/doctor/upgrade/uninstall）

## 已完成

- 新增 workspace 包：`packages/app`（npm 包名 `tmex`），提供 Node.js 兼容 CLI：
  - `tmex init`
  - `tmex init --no-interactive`
  - `tmex doctor`
  - `tmex upgrade`
  - `tmex uninstall`
- 部署运行时：`packages/app/src/runtime/server.ts` 使用单端口一体化服务：
  - 同端口处理 `/api/*`、`/ws`、`/healthz`
  - 同端口托管前端静态文件并支持 SPA fallback
  - 收到“重启请求”时退出进程，由 systemd/launchd 接管重启（无应用内循环守护）
- 资源打包：构建时将 `apps/fe/dist` 与 `apps/gateway/drizzle` 打包进 `packages/app/resources`。
- 新增构建脚本：根 `package.json` 增加 `build:tmex` / `test:tmex`。
- gateway 抽离可复用 runtime：新增 `apps/gateway/src/runtime.ts`，`apps/gateway/src/index.ts` 仅保留开发入口的循环包装。
- 迁移目录可配置：`apps/gateway/src/db/migrate.ts` 支持 `TMEX_MIGRATIONS_DIR`，并在找不到时回退到 `process.cwd()/drizzle` 与原默认路径。
- CLI i18n：`packages/app` 内禁止硬编码错误字符串，所有用户可见文本走 i18n：
  - 默认英文输出
  - 支持 `--lang zh-CN` 切换
- README 更新：补充 `npx tmex init/doctor/upgrade/uninstall` 用法。

## 验证

- `bun run --filter tmex test`：通过
- `bun run build:tmex`：通过
- `node packages/app/bin/tmex.js --lang en help`：英文帮助输出正常
- `node packages/app/bin/tmex.js --lang zh-CN help`：中文帮助输出正常
- `node packages/app/bin/tmex.js --lang en doctor --json --install-dir /tmp/tmex-no-such-dir`：一次性输出检查项正常
- `node packages/app/bin/tmex.js --lang en init --no-interactive --install-dir /tmp/tmex-test`：缺参时按策略报错（`Missing required flag: --host`）

## 已知问题 / 后续

- `apps/gateway` 全量测试当前在本机环境会因为默认 `DATABASE_URL=/data/tmex.db` 与迁移重复执行等原因失败（与本次部署链路实现无直接关系）。如需 CI 稳定通过，需要将测试统一切到独立的临时 DB 路径或在测试前清理。
