# Plan 00：skills 管理更新 + FE 样式修复 + 结果文档补全 + Git 初始化

## 摘要

本次交付包含 4 件事：

1. 更新 `AGENTS.md`：统一使用 `npx skills` 管理 skills（不再使用 skill-installer）。
2. 修复前端“没有样式”：补齐 Tailwind v4 的 Vite 插件与配置，使现有 className 生效。
3. 补全 `prompt-archives/2026021000-tmex-bootstrap/plan-00-result.md` 的“下一步建议”，并修正 skills 描述。
4. 初始化 git 仓库（main 分支）并增加正确的 `.gitignore`，创建 initial commit。

## 背景与注意事项

- 本项目为 Bun workspaces monorepo（`apps/gateway`、`apps/fe`、`packages/shared`）。
- 前端大量使用 Tailwind utility 类名（例如 `flex`、`min-h-screen`、`bg-bg-secondary`），但当前缺少 Tailwind Vite 插件与 `tailwind.config.*`，导致页面近似“无样式”。
- 数据层使用 SQLite（常见路径 `/data/tmex.db`、`/tmp/tmex.db`），需要在 `.gitignore` 中忽略 `*.db`。
- 归档规则：**先存档，再干活**。

## 实施步骤

### 0) 归档（必须先执行）

- 新建 `prompt-archives/2026021001-tmex-style-skills/` 并写入：
  - `plan-prompt.md`
  - `plan-00.md`
  - `plan-00-result.md`（实施完成后回填）

### 1) 清理误建目录

- 删除 `--help/`（误由 `npx skills init --help` 创建）。

### 2) 更新 `AGENTS.md`

- 增加 Skills 管理段落：统一使用 `npx skills`（提供 list/add/remove/update 示例）。

### 3) 修复 FE 样式

- `apps/fe/package.json`：增加 `@tailwindcss/vite` devDependency。
- `apps/fe/vite.config.ts`：注册 `@tailwindcss/vite` 插件。
- 新增 `apps/fe/tailwind.config.ts`：
  - content：`./index.html`、`./src/**/*.{ts,tsx}`
  - theme.extend.colors：把现有 CSS 变量映射为 Tailwind colors（支持 `bg-bg-secondary`、`text-text-secondary` 等）。
- 修复类名不一致：`apps/fe/src/layouts/RootLayout.tsx` 中 `text-secondary` 改为 `text-text-secondary`。
- 处理透明度类名：把 `bg-bg/50` 改为 `bg-black/50`（避免 CSS variable 透明度映射复杂化）。

### 4) 补全历史结果文档

- 更新 `prompt-archives/2026021000-tmex-bootstrap/plan-00-result.md`：
  - 把 skills 描述从 `skill-installer` 改为 `npx skills`
  - 补充 FE 样式问题与修复动作
  - 将“下一步建议”改为可执行+可验收清单

### 5) Git 初始化与 `.gitignore`

- 新增根目录 `.gitignore`（忽略 `.env`、node_modules、dist、playwright 报告、sqlite db、日志等）。
- 执行 `git init -b main`，并创建 initial commit。

### 6) 验证与归档结果

- 验证：`bun run --filter @tmex/fe build`、`bun run lint`。
- 回填 `prompt-archives/2026021001-tmex-style-skills/plan-00-result.md`。

## 验收标准

- FE 构建成功，页面 className 生效（至少 `/login`、`/devices`）。
- `AGENTS.md` 明确 skills 管理方式为 `npx skills`。
- 历史结果文档“下一步建议”可执行且与现状一致。
- git 仓库初始化完成（main 分支），`.gitignore` 生效，存在 initial commit。
