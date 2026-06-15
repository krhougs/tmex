# 0.12.3-beta1

_2026-06-15_

## English

### Fixes

- Bun detection is now reliable across install methods (Homebrew, the official installer, etc.). It no longer reports Bun as "not installed" when your shell startup prints to the terminal.

### New

- You can now point tmex at a specific Bun binary via `--bun-path <path>` (or the `TMEX_BUN_PATH` environment variable) for `init`, `doctor`, and `upgrade`. The chosen Bun is remembered and reused on later upgrades.

---

## 中文

### 修复

- 修复 Bun 检测：Homebrew、官方安装脚本等各种方式装的 Bun 现在都能被正确识别，不再因为 shell 启动时向终端打印内容而误判为「未安装」。

### 新增

- `init` / `doctor` / `upgrade` 现在支持用 `--bun-path <路径>`（或环境变量 `TMEX_BUN_PATH`）显式指定 Bun 可执行文件；指定后的 Bun 会被记住并在后续升级中复用。
