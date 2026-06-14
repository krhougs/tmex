# Files Tab 实现计划（plan-00）

## 背景

tmex 是 Bun.js monorepo（`apps/gateway` 后端、`apps/fe` 前端、`packages/app` 安装/运行时、
`packages/shared` 共享类型/i18n）。侧边栏已存在三个 Tab：`panes`（设备树）、`agent`、`files`，
其中 `files` 目前是 `components/agent-panel/files-tab.tsx` 的 "Coming Soon" 占位符。本计划把它
实现为完整的「文件浏览 + 文件查看」能力。

无上下文重新接手时的关键事实（已核实源码）：
- 后端 HTTP：`apps/gateway/src/api/index.ts` 的 `handleApiRequest(req, server)` 手写路由；按
  `path.startsWith('/api/xxx/')` 委派给子模块（llm/agent/watch 模式）。`json(data,status)` 辅助。
  无鉴权（本地/网络隔离）。`packages/app/src/runtime/server.ts` 先调 `gateway.handleRequest`，
  返回 undefined 才走静态 fe-dist（SPA fallback）。故 `/api/files/*` 天然由 gateway 处理。
- DB：Drizzle + SQLite，schema 在 `apps/gateway/src/db/schema.ts`，迁移 `drizzle/` 目录，启动时
  `runtime.ts` 调 `runMigrations()` 自动应用；`db:generate` 仅做 schema diff 不连库（安全）。
  安装版 home = 服务运行用户 home（`os.homedir()`）。
- **后端无任何文件工具**，全新构建（路径安全 / 列目录 / 读文件 / 下载）。
- **watch 子系统不做文件系统监听**（只做终端屏幕文本匹配），不可复用于文件列表自动刷新。
- 前端：React Router v7（`main.tsx` 集中路由 + `PageWrapper` 动态加载 + `PageTitle/PageActions`
  导出）；状态用 zustand + `@tanstack/react-query`（HTTP 缓存）；ws-borsh 实时；i18n 用
  react-i18next，文案在 `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json`，
  `bun run build:i18n` 生成 `resources.ts`（生成物，禁止 lint）。
- 终端配色/字体可复用：`apps/fe/src/components/terminal/theme.ts` 导出 `XTERM_THEME_LIGHT/DARK`
  （seoul256 ANSI 16 色）、`XTERM_FONT_FAMILY`、`ensureTerminalFontLoaded()`；CSS 变量 `--font-mono`。
  明暗靠 `<html>.dark` class + UIStore theme。
- 现有 Markdown：`components/markdown/streaming-markdown.tsx`（react-markdown + remark-gfm），
  无代码高亮 / mermaid / math；仅 agent 聊天使用。
- 设置面板：`pages/SettingsPage.tsx` 多 Tab；`components/settings/search-tab.tsx` 为标准链路
  （useQuery 拉取 + useEffect 绑定 + useMutation PATCH + invalidateQueries）。
- 侧边栏树样式参考 `sidebar-device-list.tsx`：`rounded-xl border-border/60`、`bg-muted/*`、
  `ScrollArea`、`Collapsible`、ghost icon 按钮、`font-mono`、`[@media(any-pointer:coarse)]` 触摸放大、
  移动端 `useSidebar()` 选中后关 Sheet。

## 目标（对应 goal 9 点）

1. 设置中可配置可访问目录白名单，默认 = 安装用户 home。
2. Files 侧边栏 Tab 提供多树根的树状文件列表（树根 = 白名单目录）。
3. 新增 `/file/:ref` 路由（`ref` = base64url 编码的绝对路径），支持代码阅读（共享终端配色/字体）、
   Markdown 预览（代码高亮 + mermaid + math + 常见扩展）、常见图片预览。
4. `/file` 与所有文件 API 严格按白名单限制（含符号链接逃逸防护）。
5. 文件查看器风格与终端一致（配色、字体、明暗）。
6. 只读；列表与查看器支持下载文件。
7. 自动刷新机制：仅对「已展开且可见」的目录轮询（React Query mount 即查询、unmount 即 GC），
   `refetchInterval`（20s）+ `refetchOnWindowFocus`；展开节点消失时从 expanded 集合剪枝、折叠、
   选中文件消失时查看器显示「已不存在」。
8. 列表提供主动刷新按钮（`invalidateQueries(['files'])`）。
9. 风格与终端/agent 一致；按文件类别/扩展名显示 lucide 图标，受支持类型显示特殊图标。

## 设计

### 后端（apps/gateway）

- `src/db/schema.ts`：新增表
  ```ts
  export const fileRoots = sqliteTable('file_roots', {
    id: text('id').primaryKey(),
    path: text('path').notNull().unique(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull(),
  });
  ```
- `src/db/file-roots.ts`（新）：`ensureFileRootsInitialized()`（表空则插入 `realpath(os.homedir())`）、
  `getFileRoots()`、`addFileRoot(path)`、`deleteFileRoot(id)`。`runtime.ts` 在
  `ensureAgentSettingsInitialized()` 后调用初始化（受 `initializeSiteSettings` 开关约束）。
  行为说明：删空所有根后重启会重新补 home（保证可用），文档注明。
- `src/files/path-guard.ts`（新，安全核心）：
  - `getAllowedRoots(): string[]`：读 DB → `realpathSync` 规范化。
  - `resolvePathWithinRoots(input): { ok; realPath; root } | { ok:false; code }`：要求绝对路径 →
    `realpathSync`（解析符号链接，ENOENT→not_found）→ 判定 `real === root || real.startsWith(root+sep)`。
- `src/files/service.ts`（新）：`listDirectory` / `readTextFile` / `statFile`，含：
  - 类别推断 `categorize(name)` → `code|markdown|image|pdf|text|binary|other` + MIME。
  - 列目录：`readdir withFileTypes` + `lstat`，目录在前、名称排序，上限 ~2000 项（truncated 标记），
    标注 symlink。
  - 读文本：`stat` 大小，>2MB 返回 tooLarge；首块 null 字节 → binary 拒绝；UTF-8 解码（按字节安全截断
    超限内容，参考 web.ts truncateUtf8）。
  - raw 下载：`Bun.file(realPath)` + MIME + 可选 `Content-Disposition: attachment`。
- `src/api/files.ts`（新）：`handleFilesApiRequest(req, path)`：
  - `GET /api/files/roots`、`POST /api/files/roots`、`DELETE /api/files/roots/:id`
  - `GET /api/files/list?path=`、`GET /api/files/content?path=`、`GET /api/files/stat?path=`
  - `GET /api/files/raw?path=[&download=1]`
  - 在 `api/index.ts` 委派：`if (path.startsWith('/api/files')) { const r = handleFilesApiRequest(...); if (r) return r; }`
- 迁移：`cd apps/gateway && bun run db:generate` 生成 `drizzle/000X_*.sql`（源真值；安装包 resources
  由 build 的 bundle:resources 复制，不手改）。
- 错误文案走 i18n（`apiError.*`）。

### 共享类型（packages/shared/src/index.ts）

`FileCategory`、`FileRootDto`、`FileEntryDto`、`FileListResponse`、`FileContentResponse`、
`FileStatResponse` 等纯类型，供前后端共用。

### 前端（apps/fe）

- 依赖新增：`highlight.js`、`rehype-highlight`、`mermaid`、`remark-math`、`rehype-katex`、`katex`。
- `src/utils/fileUrl.ts`：`encodeFileRef(path)` / `decodeFileRef(ref)`（base64url）。
- `src/stores/file-tree.ts`：`expanded: Set<string>`、`toggle/expand/collapse/prune`（不持久化）。
- `src/components/files-panel/`：
  - `files-tab.tsx`（FilesTab）：标题 + 刷新按钮；拉 `['files','roots']`；渲染各根为树节点；空态。
  - `file-tree-node.tsx`：递归节点；目录 Collapsible，展开后查询 `['files','list', path]`
    （`refetchOnWindowFocus`、`refetchInterval:20000`、`refetchIntervalInBackground:false`）；
    文件 NavLink → `/file/:ref`，带下载与图标；vanish 剪枝（unmount 清 expanded、404 折叠）。
  - `file-icon.tsx`：`fileIconFor(entry)` 按类别/扩展名映射 lucide 图标。
  - 风格镜像 `sidebar-device-list.tsx`。
- `src/pages/FilePage.tsx`：按 `stat.category` 分发：image→`<img src=raw>`；markdown→`<MarkdownPreview>`；
  code/text→`<CodeViewer>`；binary/tooLarge/other→元数据卡 + 下载。导出 `PageTitle`（文件名）/
  `PageActions`（下载/刷新/raw）。`/file/:ref` 注册到 `main.tsx`。
- `src/components/code-viewer/`：`code-viewer.tsx`（highlight.js + 行号 + `font-mono`）+
  `hljs-terminal-theme.css`（hljs token → seoul256 ANSI 色，`.dark` 切换）。共享终端配色。
- `src/components/markdown/markdown-preview.tsx`（整文档，非流式）：remark-gfm + remark-math +
  rehype-katex + rehype-highlight + 自定义 `code`（mermaid 动态 import 渲染）/`img`（相对路径
  解析到 `/api/files/raw`）。导入 katex css。
- `src/components/settings/files-tab.tsx`：根白名单管理（列表 + 增 + 删），走 `/api/files/roots`；
  注册到 `SettingsPage.tsx`。
- `app-sidebar.tsx`：`FilesTab` import 改指 `@/components/files-panel/files-tab`，删旧占位符。
- i18n：新增 `files.*`、`settings.files.*`、`file.*`、`apiError.file*` 等键（en/zh/ja），
  `bun run build:i18n`。

## 任务清单

1. 后端：schema + file-roots DB + 初始化接线 + 迁移生成。
2. 后端：path-guard + service + files API + 路由委派 + 单测（穿越/symlink/二进制/越界）。
3. 共享：DTO 类型。
4. 前端：fileUrl util、file-tree store、FilesTab 树、file-icon、自动刷新 + 剪枝。
5. 前端：CodeViewer + hljs 终端主题 CSS。
6. 前端：MarkdownPreview（高亮 + mermaid + math + 图片）。
7. 前端：FilePage + 路由注册 + PageTitle/PageActions + 下载。
8. 前端：设置 Files Tab + SettingsPage 注册。
9. i18n 三语言 + build:i18n。
10. 依赖安装、typecheck、fe build、后端单测、临时实例 smoke（curl）。

## 验收标准

- 设置可增删白名单根，默认含安装用户 home；非绝对/不存在/非目录的根被拒。
- Files Tab 显示多根树，懒加载、可展开折叠、图标正确；刷新按钮可用；自动刷新仅查已展开目录；
  展开目录被删后自动剪枝不报错。
- `/file/:ref` 正确渲染代码（终端配色/字体）、Markdown（高亮/mermaid/math/图片）、图片；越界路径
  返回 403/404 且前端友好提示；下载可用。
- 所有文件 API 严格白名单限制，符号链接无法逃逸（单测覆盖）。
- typecheck/build 通过；后端文件单测通过；临时实例 API smoke 通过。
- 不触碰生产 tmex；临时实例显式覆盖端口/DB/FE_DIST。

## 风险与注意

- 符号链接逃逸：必须 realpath 后再判定根包含，单测覆盖。
- 大文件/二进制：先 stat 再决定，绝不全量读入内存后截断。
- 自动刷新流量：只查可见展开目录 + 适中间隔 + 窗口聚焦刷新；不做全树轮询。
- mermaid/katex 体积：mermaid 动态 import 仅在出现 mermaid 块时加载。
- 迁移源真值在 `apps/gateway/drizzle`；`packages/app/resources/gateway-drizzle` 由 build 复制，勿手改。
- 不对生成文件（resources.ts/fe-dist/dist）lint。
- 验证一律用仓库内临时实例（端口 9885/9665、覆盖 DATABASE_URL/TMEX_FE_DIST_DIR），绝不动 9883 常驻服务。
