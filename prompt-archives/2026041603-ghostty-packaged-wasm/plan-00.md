# Plan 00：ghostty packaged wasm

## 背景

tmex 当前已经把 Ghostty 的 wasm 产物放在 `packages/ghostty-terminal/src/assets/ghostty-vt.wasm` 中，并由 `packages/ghostty-terminal/src/ghostty-wasm.ts` 在运行时懒加载。但是当前流程仍然缺少一个正式的、可审计的资产约束：没有单独记录 wasm 对应的 `vendor/ghostty` 锁定 commit，也没有把“手动更新资产”和“自动化只做校验”的边界显式固化。

用户要求是将这件事收敛为一个稳定流程：wasm 作为包内受控资产提交到 git tree；提供显式的手动更新脚本；所有自动化只检查资产与锁定版本是否一致，不在测试、构建、CI 等自动化场景下触发编译。

## 注意事项

- 先归档，再干活。
- 不改 `apps/fe` 业务逻辑。
- 运行时不增加任何自动构建回退。
- 不把产物继续放在 `vendor/ghostty` 目录中消费。
- 自动化只允许校验，不允许编译。

## 任务清单

1. 在 `packages/ghostty-terminal` 内新增 wasm 元数据文件，记录锁定的 ghostty commit、wasm hash、文件大小等信息。
2. 为元数据校验补最小失败测试，覆盖：wasm 缺失、metadata 缺失、metadata commit 不匹配等场景。
3. 新增一个包内脚本模块，提供 `verify` 与 `write-metadata` 两个模式。
4. 调整 `scripts/build-wasm.sh`，让它在手动更新路径中写回 metadata，并校验 submodule HEAD 与锁定 commit 一致。
5. 调整 `package.json` 脚本命名，使 `update:wasm` 明确表示手动更新，`verify:wasm` 明确表示自动化校验。
6. 更新运行时文档，明确“运行时只读已提交 wasm、自动化只校验”的约束。
7. 跑测试、类型检查、包级校验脚本与现有 wasm 相关测试，并记录结果。

## 验收标准

- `packages/ghostty-terminal` 内有受控的 wasm 元数据文件。
- `verify:wasm` 能在不触发编译的前提下校验 wasm 资产和锁定 commit 一致性。
- `update:wasm` 是显式手动入口，且会同步更新 metadata。
- 现有 wasm 运行时测试不回归。
- 文档明确说明维护流程与自动化边界。

## 风险评估

- 若未来只更新 submodule 而忘记更新 wasm/metadata，会被新校验脚本拦下。
- 若 `build-wasm.sh` 被误用于自动化流程，仍可能引入 Zig/构建链依赖，因此需要通过脚本命名和文档收紧边界。
