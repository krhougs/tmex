# 执行结果：issue #28 bun 路径解析重构

## 结论

issue #28 的现象真实，但**原始诊断错误**：bun 已被检测到（报错带出了路径），真因是 `locateBunFromShell()` 用交互式 `zsh -lic`，stdout 被 `.zshrc` 的 ANSI 控制序列污染，`trim()` 去不掉，导致返回的路径串夹带控制字符、`spawn` 失败。issue 建议的「加 homebrew 路径」修复无效（短路逻辑）。已按用户确认方案（安装期定 + 存 meta + 复用 + 允许显式传入）重构，并完成多维度对抗审查与修复。

## 已实现

| 项 | 文件 |
|---|---|
| bun 路径来源优先级（显式 → execPath → meta → 动态探测 → 硬编码 fallback）+ `sanitizeBunPath`（CSI/OSC 净化 + 取绝对路径行）+ `validateBunAt`（超时）+ `readExplicitBunPath` | `packages/app/src/lib/bun.ts` |
| `runCommand` 超时 + stdin 重定向 `/dev/null`（非交互 fail-fast） | `packages/app/src/lib/process.ts` |
| `InstallMeta.bunPath?`（可选，兼容旧 meta） | `packages/app/src/types.ts` |
| init/doctor/upgrade 接 `--bun-path` / `TMEX_BUN_PATH`，写入/复用 meta.bunPath | `packages/app/src/commands/{init,doctor,upgrade}.ts` |
| run.sh PATH 兜底（去重、homebrew/linuxbrew）+ bunPath 注入校验 | `packages/app/src/lib/install.ts` |
| `bun.explicitInvalid` / `bun.unsafePath` 文案 + `--bun-path` help（en/zh） | `packages/app/src/i18n/index.ts` |
| 自更新显式传 `--bun-path process.execPath`；meta 形状增 bunPath | `apps/gateway/src/system/{upgrade,install-info}.ts` |
| 单测（净化/优先级/超时回退/显式拒绝/issue#28 回归） | `packages/app/src/lib/bun.test.ts`（新增） |
| 设计文档 | `docs/update/2026061502-bun-path-resolution.md` |

改动统计：10 文件 +323/-67，新增测试 + 文档。

## 对抗审查（多 agent workflow）

5 维度并行深审 + 每条发现独立验证：32 findings，22 confirmed，10 rejected（误报）。confirmed 去重后核心问题均已修复：

- **显式相对路径漏洞**（blocker）：相对路径跳过校验、报错不准 → 改为要求「存在的绝对路径」，否则 `explicitInvalid`。
- **`InstallMeta.bunPath` 类型契约**（blocker）：必填 → 可选，匹配旧数据现实。
- **run.sh PATH 重复**（major）：`${HOME}/.bun/bin` 条件块与 extraPathDirs 重复 → extraPathDirs 排除 `~/.bun/bin`。
- **shell 注入 / DoS**（major）：bunPath 含 `"`/`` ` ``/`$`/`\`/换行 → 抛 `unsafePath`。
- **sanitizeBunPath 增强**：OSC 序列 + trailing banner（取绝对路径行）+ version 输出净化。
- **一致性/质量**：`validateBunAt` 超时、`readExplicitBunPath` 提取（DRY）、诊断字段非 undefined。

驳回的 10 项已确认为误报（如 PATH 大小写去重——大小写敏感 fs 上属不同目录不应去重；timer unref / gateway execPath 假设等均有防御或前提不成立）。

## 验证

- `bun test src`：**29 通过 / 0 失败**。
- `bun build`（cli + gateway runtime）：均成功。
- `biome`：改动文件干净（install.ts 仅剩 1 处**既有** format 分歧，非本次引入，HEAD 同样存在）。
- doctor 端到端冒烟（隔离临时实例，未碰生产 9883 / 服务）：显式有效 / env / 无参 → PASS；显式无效（含相对路径）→ FAIL `explicitInvalid`。
- run.sh 实测：PATH 无重复条目、`${PATH:-}` 字面正确、注入防御抛错。

## 注意

- 全程工作在 worktree `issue-28-bun-detection`，未触碰生产 tmex（9883 / `~/Library/Application Support/tmex`）。
- 期间一度误写主仓库路径，已迁移到 worktree 并还原主仓库（main 干净）。
- 未提交、未发版（按规范由用户决定）。
