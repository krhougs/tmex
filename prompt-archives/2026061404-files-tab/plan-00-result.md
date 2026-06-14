# Files Tab 实现结果总结（plan-00-result）

实现于 2026-06-14，对应 plan-00。goal 9 点全部完成并通过验证。

## 交付内容

### 后端（apps/gateway）
- `src/db/schema.ts`：新增 `file_roots` 表（id/path(unique)/sortOrder/createdAt）。
- `src/db/file-roots.ts`：`ensureFileRootsInitialized()`（表空补 `realpath(homedir)`）、
  `getFileRoots/addFileRoot/deleteFileRoot`。
- `src/runtime.ts`：启动初始化链路接入 `ensureFileRootsInitialized()`。
- `src/files/path-guard.ts`：安全核心。`resolvePathWithinRoots()` 对输入路径与白名单根都
  `realpathSync` 后判定包含关系——任何符号链接逃逸/路径穿越在解析为真实路径后即被拒。
- `src/files/service.ts`：`categorize()`（扩展名→类别+MIME）、`listDirectory`（目录优先排序、
  ~2000 项截断、symlink 标注）、`readTextFile`（先 stat 再读，>2MB 拒、NUL 字节判二进制拒、
  UTF-8 解码）、`statFile`。三个函数都支持可选 `roots` 形参（便于无 DB 单测）。
- `src/api/files.ts`：`handleFilesApiRequest`。端点：
  `GET/POST /api/files/roots`、`DELETE /api/files/roots/:id`、
  `GET /api/files/list|content|stat?path=`、`GET /api/files/raw?path=[&download=1]`（Bun.file 流式
  + MIME + Content-Disposition）。`api/index.ts` 按 `path.startsWith('/api/files')` 委派。
- `src/files/path-guard.test.ts`：17 个用例（穿越/symlink 逃逸/内部 symlink/越界/二进制/类别/排序）。
- 迁移 `drizzle/0007_fearless_pestilence.sql`（`db:generate` 生成）。

### 共享（packages/shared/src/index.ts）
`FileCategory/FileEntryType/FileRootDto/FileEntryDto/ListFileRootsResponse/AddFileRootRequest/
AddFileRootResponse/ListFilesResponse/FileContentResponse/FileStatResponse` 等纯类型。

### 前端（apps/fe）
- 依赖：highlight.js、rehype-highlight、mermaid、remark-math、rehype-katex、katex。
- `utils/fileUrl.ts`：`encodeFileRef/decodeFileRef`（base64url）、`fileRoute/filesApi/fileRawUrl`。
- `stores/file-tree.ts`：展开态（不持久化）。
- `components/files-panel/`：`api.ts`（含 `FileApiError`）、`file-icon.tsx`（类别→lucide 图标+着色）、
  `files-tab.tsx`（多根树 + 刷新按钮 + 懒加载 + 自动刷新 + 剪枝）。
- `components/code-viewer/`：`code-viewer.tsx`（highlight.js `lib/common` 子集 + 行号 + font-mono）
  + `hljs-terminal-theme.css`（seoul256 ANSI → token，`.dark` 切换；与终端共享配色）。
- `components/markdown/markdown-preview.tsx` + `mermaid-block.tsx`（gfm+math+highlight+mermaid 动态
  import + 相对图片解析到 `/api/files/raw`）。
- `pages/FilePage.tsx`：按 `stat.category` 分发（image/pdf/audio/video/markdown/code-text/fallback），
  `PageTitle`/`PageActions`（刷新/打开原始/下载）。`main.tsx` 注册 `/file/:ref`。
- `components/settings/files-tab.tsx` + `SettingsPage.tsx`：根白名单增删 UI。
- `app-sidebar.tsx`：FilesTab 改指 files-panel，删旧占位符。
- i18n：`files.*/file.*/settings.files.*/apiError.file*`（en/zh/ja）+ `build:i18n` 重生成。

## 关键设计

- **路由 ref**：`/file/:ref`，ref = base64url(绝对路径)，避免斜杠/UTF-8 问题。
- **自动刷新机制（goal 7）**：每个「已展开且可见」目录一个 React Query（key `['files','list',path]`），
  `enabled=expanded`（折叠即停止请求，省流量）、`refetchInterval=20s`、
  `refetchIntervalInBackground=false`、`refetchOnWindowFocus`。折叠子树组件卸载→query GC。
  **剪枝**：目录刷新成功后对比子目录集合，把「曾展开但已消失」的直接子目录 `collapse`；目录自身
  404/403 时自动折叠。watch 子系统只做终端文本匹配、无 FS 监听，故未复用。
- **手动刷新（goal 8）**：按钮 `invalidateQueries(['files'])`，spinner 用 `useIsFetching`。
- **配色一致（goal 3/5）**：代码高亮主题与 markdown 代码块共用 `hljs-terminal-theme.css`，取值即
  `components/terminal/theme.ts` 的 seoul256；字体 `font-mono`（GeistMono）。
- **白名单安全（goal 4）**：所有文件端点经 `resolvePathWithinRoots`，realpath 后判根包含，
  symlink/穿越均拒。

## 验证结果（全绿）

- 后端单测：`bun test`（gateway）**545 pass / 0 fail**（含 17 个 files 安全用例）。
- 前端：`tsc --noEmit` 通过；`bun run build`（tsc+vite）成功，mermaid 被 code-split，
  FilePage chunk 604kB（gzip 186kB，highlight.js 由 full→common 优化掉约 1MB）。
- 临时实例 API smoke（NODE_ENV=test + 显式 DATABASE_URL=/tmp + GATEWAY_PORT=19771，不触碰 9883/dev/prod）：
  roots 自动 seed home；list 目录优先排序+类别正确；content 文本 OK / 二进制 415；raw 返回正确
  Content-Type 与字节；download 带 Content-Disposition；**安全：/etc 403、/etc/passwd 403、
  穿越 403；删除根后该根 403**。
- 真实浏览器 smoke（playwright，静态 dist + /api 代理）：Files tab 树渲染、图标着色、展开、markdown
  预览、代码高亮（终端配色）、图片预览、设置 Files tab 均通过，截图已核验。
- biome：16 个新文件全部 clean。`main.tsx` 仅剩 `useExhaustiveDependencies`——经核实为 HEAD 既有、
  位于 `StatusBarSync`，非本次引入，未改动。

## 注意 / 后续

- 生产迁移：`apps/gateway/drizzle/0007_*.sql` 为源真值（已提交）；
  `packages/app/resources/gateway-drizzle` 是 gitignore 的构建产物，由 `bundle:resources` 在
  `bun run build`/发版时复制。用户走正常发版 + `tmex upgrade` 即可，无需手动同步。
- `agent.files.comingSoon` i18n key 现已无引用（占位符删除），保留无害。
- 删空所有根后重启会再次 seed home（刻意，保证 Files 始终可用）。
