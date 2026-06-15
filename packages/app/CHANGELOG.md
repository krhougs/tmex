# 0.12.4

_2026-06-15_

## English

### New

- The Agent can now recognize and work with a coding agent running inside a terminal pane — when an AI coding assistant is active in a pane, tmex's Agent understands it and can act on it.

### Fixes

- More reliable Bun detection during install and startup (issue #28). You can now point tmex at a specific Bun with `--bun-path`, and that choice is remembered for later runs.

---

## 中文

### 新增

- Agent 现在能识别并配合在终端 pane 内运行的编码助手——当某个 pane 里有 AI 编码助手在运行时，tmex 的 Agent 能感知它并对其进行操作。

### 修复

- 更可靠地检测 Bun（安装与启动时，issue #28）；现在可以用 `--bun-path` 指定使用哪个 Bun，并会记住该选择供后续复用。
