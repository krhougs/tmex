# Plan 00 执行结果：ghostty packaged wasm

时间：2026-04-16

## 完成内容

### 1）新增包内 wasm metadata 与校验脚本

- 新增文件：`packages/ghostty-terminal/src/assets/ghostty-vt.meta.json`
- 新增文件：`packages/ghostty-terminal/scripts/ghostty-wasm.ts`
- 新增文件：`packages/ghostty-terminal/scripts/ghostty-wasm.test.ts`

实现结果：

- 包内 wasm 现在有对应的 metadata 文件，记录：
  - `ghosttyCommit`
  - `assetPath`
  - `wasmSha256`
  - `wasmSize`
- 新增脚本支持两个模式：
  - `verify`：只校验已提交 wasm 与 metadata、锁定 submodule commit 是否一致
  - `write-metadata`：根据当前锁定 commit 和现有 wasm 文件重写 metadata
- 测试覆盖了：
  - metadata 生成
  - 正常校验通过
  - commit 不一致时报错
  - wasm 文件缺失时报错

### 2）收紧手动更新边界

- 修改文件：`packages/ghostty-terminal/scripts/build-wasm.sh`
- 修改文件：`packages/ghostty-terminal/package.json`

实现结果：

- `build-wasm.sh` 现在会先校验：
  - superproject 锁定的 `vendor/ghostty` commit
  - 当前 submodule checkout HEAD
  - 两者不一致时直接失败
- 编译并复制 wasm 后，会调用 `ghostty-wasm.ts write-metadata` 同步 metadata
- 包脚本调整为：
  - `update:wasm`：显式手动更新入口
  - `build:wasm`：作为 `update:wasm` 的别名保留
  - `verify:wasm`：自动化校验入口

### 3）补充运行时文档

- 修改文件：`docs/terminal/2026041600-ghostty-wasm-runtime.md`

实现结果：

- 文档现在明确：
  - 运行时只读取 `packages/ghostty-terminal/src/assets/ghostty-vt.wasm`
  - metadata 位于 `packages/ghostty-terminal/src/assets/ghostty-vt.meta.json`
  - `update:wasm` 是手动维护入口
  - `verify:wasm` 是自动化校验入口
  - 自动化遵循“never build, only verify”原则

## 验证证据

### Red

- 命令：`bun test packages/ghostty-terminal/scripts/ghostty-wasm.test.ts`
- 结果：修复前失败，原因是 `scripts/ghostty-wasm.ts` 模块不存在。

### Green

- 命令：`bun test packages/ghostty-terminal/scripts/ghostty-wasm.test.ts`
- 结果：`4 pass, 0 fail`

### 手动脚本检查

- 命令：`bun run --cwd packages/ghostty-terminal verify:wasm`
- 结果：通过，并输出当前锁定 commit `43a05dc968eda9bfa2196d66ba1819daf510b62a` 与 wasm sha256 `7bde84bf8e962a3abecdd936bb7bb1a5e97548cd20d42d7d9c49567ddf9e4c9b`

- 命令：`bun run --cwd packages/ghostty-terminal ./scripts/ghostty-wasm.ts write-metadata`
- 结果：通过，成功重写 metadata 文件。

### 现有 wasm 回归

- 命令：`bun test packages/ghostty-terminal/src/terminal.canvas.test.ts`
- 结果：`6 pass, 0 fail`

### 诊断 / 类型检查

- `lsp_diagnostics`：`packages/ghostty-terminal/scripts` 目录 0 error
- 命令：`bunx tsc -p packages/ghostty-terminal/tsconfig.json --noEmit`
- 结果：失败
- 失败内容表现为该包原有的 Bun 类型缺失与旧测试类型问题，例如：
  - `src/ghostty-wasm.ts` 中 `Bun` 类型未声明
  - `src/terminal.canvas.test.ts` 中 `bun:test` 模块与若干旧类型报错

这些错误在本次变更前就已存在，不是新增脚本和 metadata 引入的回归。

## 结论

本次实现已经把 Ghostty wasm 资产管理边界收紧到 `packages/ghostty-terminal` 包内：运行时只读已提交 wasm，手动更新走显式脚本，自动化只做校验不做编译。现有 wasm 相关测试保持通过，新的 metadata/commit 校验能力已经落地。 
