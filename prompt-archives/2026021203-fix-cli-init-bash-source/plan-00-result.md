# 执行结果：修复 `cli init` 报错 `BASH_SOURCE is not defined`

## 根因结论
- `packages/app/src/lib/install.ts` 的 `writeRunScript()` 使用 JS 模板字面量生成 bash 脚本。
- 脚本内容包含 `${BASH_SOURCE[0]}`，被 JS 当作插值表达式执行，导致运行期抛出 `ReferenceError: BASH_SOURCE is not defined`，从而 `tmex init` 直接失败。

## 修复内容
- `packages/app/src/lib/install.ts`：改为数组 `join('\n')` 拼接脚本文本，避免模板字面量误插值；脚本目录定位改为基于 `$0`（`dirname "$0"`），不再依赖 `BASH_SOURCE`。
- `packages/app/src/lib/install.test.ts`：新增回归测试，覆盖 `writeRunScript()` 能成功写出脚本且不包含 `BASH_SOURCE`。
- `packages/app/src/lib/install.ts`：`run.sh` 增加对 `~/.bun/bin` 的 PATH 兜底，避免 systemd/launchd 环境 PATH 不包含用户目录导致 `bun: not found`。
- `packages/app/src/lib/service.ts`：修复 systemd unit 渲染，`WorkingDirectory` 不再包裹双引号，避免 systemd 将其判定为非绝对路径。
- `packages/app/src/lib/service.test.ts`：新增回归测试，锁定 `WorkingDirectory=/absolute/path`（无引号）格式。
- `packages/app/src/commands/upgrade.ts`：移除重复 `startService()` 调用，避免 launchd 场景重复 bootstrap；systemd 安装服务时改为 `enable` + `restart`，保证升级后进程必然切换到新版本。
- `packages/app/src/lib/bun.ts`：`findBunBinary()` 优先返回绝对路径（zsh 解析路径或 `~/.bun/bin/bun`），避免将 `"bun"` 写入 `run.sh` 导致 systemd PATH 下找不到可执行文件。
- `packages/app/src/commands/upgrade.ts`：健康检查由“单次请求”改为“30 秒窗口轮询重试”，避免服务冷启动时误判失败并触发回滚。
- `packages/app/package.json`：版本号 bump 为 `0.1.2`（patch 发版准备）。

## 验证证据
- 单测（先 red 后 green）：
  - `bun test packages/app/src/lib/install.test.ts`：修复前失败（`ReferenceError: BASH_SOURCE is not defined`），修复后通过。
- 包级测试：
  - `bun run --filter tmex-cli test`：通过（13 tests, 0 fail）。
- 构建：
  - `bun run --filter tmex-cli build`：通过（runtime + cli 均成功产出 dist）。
- 现场验证：
  - `node packages/app/bin/tmex.js --lang zh-CN upgrade --apply-current-package --install-dir /home/krhougs/.local/share/tmex`：通过。
  - `systemctl --user status tmex.service`：`active (running)`，主进程为 `/home/krhougs/.bun/bin/bun .../runtime/server.js`。
  - `curl http://127.0.0.1:3000/healthz`：返回 `200`，`{"status":"ok","restarting":false}`。

## 影响评估
- CLI 对外参数/行为不变。
- 生成的 `run.sh` 仍由 bash 执行（systemd/launchd 已显式指定 bash），脚本目录定位改为 `$0` 适用于“执行型脚本”场景（init/服务启动）。
