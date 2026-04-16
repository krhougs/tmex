## Prompt 00

- 用户要求：我们应该放一份编译好 wasm 文件在 git tree 里，留一个脚本去在 ghostty wrapper 中准备这个文件，然后不要在任何自动化场合中去触发编译。
- 进一步约束：放在单独维护的 `ghostty-terminal` 这个 JS 包里，其他细节由我自行判断。
- 实施目标：把编译好的 Ghostty wasm 固定到 `packages/ghostty-terminal` 包内；提供手动更新脚本；运行时只读取现成 wasm；自动化只做存在性和版本一致性校验，不触发编译。

## 当前事实

- `packages/ghostty-terminal/src/assets/ghostty-vt.wasm` 已存在并被运行时加载。
- `packages/ghostty-terminal/scripts/build-wasm.sh` 当前会从 `vendor/ghostty` 子模块编译 wasm，再复制到包内资产目录。
- `vendor/ghostty` 是锁定到具体 commit 的 submodule。
- 问题不在运行时加载，而在缺少受控的元数据与“手动更新 / 自动校验”边界。
