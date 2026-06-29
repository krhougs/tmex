# 0.14.0

_2026-06-29_

## English

### New

- Clipboard support for terminal programs: apps like vim, Claude Code, and other TUI tools can now copy text to your system clipboard via the terminal (OSC 52). A brief toast confirms each copy.
- Configurable default working directory: set a default path for new terminal windows per device — new windows and panes open there instead of the home directory. Changes take effect immediately without disconnecting.
- Installer now guides you through installing missing dependencies (tmux, bun) during setup, with distro-specific commands for common Linux distributions.

### Improvements

- Notification toasts now show the terminal name or running command (e.g. "vim", "make") instead of a numeric pane index, making it easier to identify which terminal triggered an alert.
- `tmex doctor` suggests `tmex doctor --fix` when it finds fixable issues, and `--fix --no-interactive` works fully unattended for scripted installs.
- The installer detects whether systemd is available on Linux before proceeding, instead of failing midway on container or WSL environments without it.

### Fixes

- Fixed non-ASCII filenames (Chinese, Japanese, Korean, etc.) showing as garbled escape sequences in the file browser on Linux servers.

---

## 中文

### 新增

- 终端程序剪贴板支持：vim、Claude Code 等 TUI 程序现在可以通过终端直接复制文本到系统剪贴板（OSC 52），复制成功时会显示提示。
- 可配置默认工作目录：可为每台设备设置新终端窗口的默认路径，新窗口将在该目录下打开而非主目录。修改后立即生效，无需断开连接。
- 安装器现在会在安装过程中引导用户安装缺失的依赖（tmux、bun），并为常见 Linux 发行版提供专属的安装命令。

### 改进

- 通知提示现在显示终端名称或正在运行的命令（如"vim"、"make"），而非数字索引，更容易识别是哪个终端触发了提醒。
- `tmex doctor` 检测到可修复的问题时会提示使用 `tmex doctor --fix`，且 `--fix --no-interactive` 支持完全无人值守的脚本化安装。
- 安装器在 Linux 上会先检测 systemd 是否可用，在容器或无 systemd 的 WSL 环境中提前给出明确错误，而非中途失败。

### 修复

- 修复了 Linux 服务器文件浏览器中中日韩等非 ASCII 文件名显示为乱码转义序列的问题。
