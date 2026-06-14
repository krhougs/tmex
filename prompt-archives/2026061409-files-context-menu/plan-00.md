# 文件系统迭代：文件列表 node 右键/长按菜单 + 拖拽传输（issue #21）

## Context（背景与目标）

issue #21（`文件系统迭代`，已打 `confirmed` 标签）要求给 Files Tab 文件树的每个 node 增加**右键菜单（移动端长按菜单）**，并补齐文件传输能力：

- **所有 node**：复制绝对位置、复制相对位置（相对于树根）、发送到 Agent（在所属设备建一个新 tmux 窗口，并把该文件/文件夹的绝对路径预填进 agent 输入框）。
- **文件夹**：展开/收起、上传文件到这个文件夹（支持把系统文件拖拽到文件夹 node 上）。
- **文件**：打开、下载（支持把 node 直接拖拽到操作系统中下载）。

当前 Files Tab（`apps/fe/src/components/files-panel/files-tab.tsx`）只有：点击展开目录、点击打开文件、一个内联下载按钮。**没有右键/长按菜单、没有上传能力、没有任何 HTML5 拖拽**。本次迭代补齐这三块。

**产品决策（已与用户确认）**：
1. **下载入口移入菜单，移除文件行的内联下载图标按钮**（下载只通过：右键/长按菜单的"下载"项 + 拖拽到桌面）。
2. **仅右键(桌面)/长按(移动)触发菜单，不额外加常显的 ⋮ 按钮**（严格按 issue 范围）。

## 关键技术结论（已对源码/浏览器 API 逐项核实，禁止再凭记忆改动）

1. **base-ui ContextMenu 可直接用**。项目实际解析版本是 `@base-ui/react@1.2.0`（`bun.lock` 锁定，`node_modules/@base-ui/react` 软链指向它；1.4.0 也在 `.bun` 但不生效，两版 context-menu 源码逐行一致）。
   - 单入口：`import { ContextMenu } from '@base-ui/react/context-menu'`，拿到 `Root/Trigger/Portal/Positioner/Popup/Item/Separator/Group/SubmenuRoot/SubmenuTrigger/LinkItem` 等全部 part。
   - `ContextMenu.Trigger` **原生同时支持桌面右键 + 触摸长按（硬编码 500ms，不可配）**，无需任何手势 hook；**不要引入** `useMobileTouch`。
   - 用 `render={<button onClick={…}/>}` 把触发能力**合并进现有按钮**（base-ui `mergeProps` 保留 button 的 `onClick`），左键展开/打开与右键/长按菜单天然并存。**不要**用 children 再套一层 div。
   - **不存在 `SubmenuContent` 这个 part**；本次菜单层级简单（"发送到 Agent" 是单个 Item，不是子菜单），用不到 Submenu。
   - 容器现有的 `select-none [-webkit-touch-callout:none]` 与长按不冲突，正是抑制 iOS 系统 callout 所需，保留。

2. **下载拖到桌面 = `DownloadURL` DataTransfer**。`onDragStart` 里 `e.dataTransfer.setData('DownloadURL', `${mime}:${filename}:${absUrl}`)`，**URL 必须是绝对地址**：`window.location.origin + fileRawUrl(rootId, path, true)`（同源，安全）。**仅 Chromium（Chrome/Edge）生效**，Firefox/Safari 静默无效——这正是为何下载仍需菜单项兜底。移动端（coarse pointer）无系统落点，拖出/拖入都只在 fine pointer 启用。

3. **上传拖入 = HTML5 drop**。drop target（文件夹 node）必须在 `onDragOver` 和 `onDrop` 都 `preventDefault()`；用 `Array.from(e.dataTransfer.types).includes('Files')` 守卫（Firefox 的 `types` 是 `DOMStringList` 无 `includes`，必须 `Array.from`），只接管"外部文件拖入"、天然排除内部 node 拖拽；`e.dataTransfer.files` **只有 drop 阶段有内容**；dragenter/dragleave 用 `ref` 计数去抖避免高亮闪烁。

4. **上传后端是新增的反向 rsync**（现有只有"设备→本机"拉取，无任何上传）。
   - 新增 `rsyncUploadArgs(spec, localSource, remoteDest)`（与 `rsyncCopyArgs` 对称，调换源/目标、**不加 `-L`**）：`[(-e rsh)?, localSource, rsyncTargetArg(spec, remoteDest)]`。
   - **路径安全要点**：上传目标文件尚不存在，**不能**对目标文件跑 `checkAndNormalize`（local 分支 `realpathSync` 对不存在路径会抛错→`not_found`）。正确做法：对 **destDir** 跑 `checkAndNormalize`（它存在）→ `statViaRsync` 确认是目录（否则 `not_a_directory`）→ 文件名用**独立的** `sanitizeUploadName`（取最后一段，拒绝 `''`/`.`/`..`/含 `/` 或 NUL）→ `posixJoin(destNorm, name)` 拼最终远端路径。
   - Bun.serve 默认 `maxRequestBodySize` 128MB；前端**按文件逐个请求**上传（每文件一个 POST），既给每文件独立 toast/失败反馈、又稳稳低于 body 限制。后端每文件 cap 100MB。
   - 失败分类复用 `classifyRsyncFailure`；错误码全部复用现有 `FileErrorCode`（`not_a_directory`/`too_large`/`permission_denied`/`connection_failed`/`rsync_missing_*`/`timeout` 等，三语言已有本地化），**无需新增 code**。

5. **发送到 Agent 直接复用现有编排**。`rsync-install-flow.ts` 的 `triggerRsyncInstall` 已实现"连接设备→建窗→pollUntil 等就绪→`startDraft` 预填 prompt→`bridgeNavigate`→`setSidebarTab('agent')`→`bridgeOpenMobileSidebar`"，除 prompt 文案外与业务无关。抽成通用函数复用即可。`FileEntryDto.path` 已是设备绝对路径，直接用作预填内容；device 取 **`root.deviceId`**（不是 `ctx.localDeviceId`）。

## 实现步骤

> 先存档：按 `AGENTS.md`，开工前在 `prompt-archives/2026061409-files-context-menu/`（沿用日期+编号规则）建 `plan-prompt.md` 存档本 issue 与后续 prompt，并把本计划复制为 `plan-00.md`；完成后写 `plan-00-result.md`。

### 1. i18n（先改源，再生成）
在 `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` 的 `translation.files` 下新增（三语言同步）：
- `menu.copyAbsolute` / `menu.copyRelative` / `menu.sendToAgent` / `menu.expand` / `menu.collapse` / `menu.upload` / `menu.open` / `menu.download`
- `copied`（复制成功 toast）
- `sendToAgent.prompt`（如 `请处理这个路径：\`{{path}}\``）
- `upload.success` / `upload.fail`（带 `{{name}}`）
- `agentLaunch.connectFailed` / `agentLaunch.windowFailed`（通用化原 `install.connectFailed/windowFailed`，让 rsync 安装与 send-to-agent 共用；原 `install.*` 改为引用或保留）

然后 `bun run build:i18n` 重新生成 `resources.ts`/`types.ts`。**严禁手改/lint 这两个生成文件**。

### 2. 后端：上传能力
- `apps/gateway/src/files/ssh-command.ts`：新增 `rsyncUploadArgs(spec, localSource, remoteDest)`（见上文结论 4）。
- `apps/gateway/src/files/device-storage.ts`：新增 `sanitizeUploadName(raw)` 与 `uploadFiles(rootId, destDir, files)`：`resolveContext` → `checkAndNormalize(device, root.path, destDir)` → `enqueueDeviceJob(device.id, …)`（单 job 内 `buildRsyncDeviceSpec` 一次、`finally` cleanup）→ `statViaRsync` 确认 destDir 是目录 → 逐文件：消毒名、cap `UPLOAD_MAX_BYTES`(100MB)、写本机临时文件（`mkdtempSync` + `Bun.write`/`writeFileSync`）、`runRsync(rsyncUploadArgs(...), {env, timeoutMs: 120_000})`、`classifyRsyncFailure`、`rmSync` 清理。返回 `FileOpResult<{ uploaded: string[] }>`。
- `apps/gateway/src/api/files.ts`：在 `handleFilesApiRequest` 加 `POST /api/files/upload` → `handleUpload(req)`：`await req.formData()`，取 `rootId`、`path`(=destDir)、`files`(`getAll('files')` 过滤 `File`)，调 `uploadFiles`，复用 `codeError` 映射。`api/index.ts` 已按 `/api/files` 前缀分发，无需改。

### 3. 前端：context-menu 封装组件（复用）
新建 `apps/fe/src/components/ui/context-menu.tsx`，**参照** `apps/fe/src/components/ui/dropdown-menu.tsx` 的封装范式：`import { ContextMenu } from '@base-ui/react/context-menu'`，`ContextMenuTrigger` 做成透传 `render` 的薄包装，`Popup/Item/Separator` 的 className 串几乎可整段复制（同一批 menu primitive，`--available-height/--anchor-width/--transform-origin` 通用）。

### 4. 前端：上传/路径/剪贴板工具
- `apps/fe/src/components/files-panel/api.ts`：新增 `uploadFile(rootId, destDir, file)`（单文件 `FormData` POST），失败走现有 `parseError`。
- 路径工具：在 files-panel 内加 `relativeToRoot(rootPath, path)`（剥离 `rootPath` 前缀，root 自身返回 `.` 或 basename）。
- 剪贴板：复用 `packages/ghostty-terminal/src/selection-clipboard.ts` 的 `writeTextToClipboard`；若跨包导出不便，在 files-panel 内用 `navigator.clipboard.writeText` + `execCommand` 兜底的小工具。

### 5. 前端：`rsync-install-flow.ts` 通用化
- 把 `installInProgress` 锁改名 `agentOrchestrationInProgress`（通用 agent 编排互斥）。
- 抽出 `openAgentInNewWindowWithPrompt(deviceId, promptText)` 承载全部编排（含锁、连接、建窗、`startDraft`、导航、切 agent、开 sidebar、失败 toast 改用 `files.agentLaunch.*`）。**务必保持 `startDraft → bridgeNavigate → setSidebarTab → openMobileSidebar` 的原有顺序**（避免路由变化触发的自动起草覆盖预填）。
- `triggerRsyncInstall` 退化为薄封装；新增 `sendPathToAgent(deviceId, absPath)` + `buildSendToAgentPrompt(absPath)`（rsync 的 `buildRsyncInstallPrompt` 原样保留）。

### 6. 前端：`files-tab.tsx` 接线（核心）
- **透传 root 到 FileLeaf**：当前 `FileLeaf` 只收 `entry/rootId/depth`，缺 `deviceId` 与 `root.path`（相对路径需要）。改为把整个 `root: FileRootDto` 传给 FileLeaf（`files-tab.tsx:312` 处 `<FileLeaf … root={root} />`）。
- **DirNode**（文件夹）：用 `<ContextMenu.Root>` + `<ContextMenu.Trigger render={<button onClick={()=>toggle(rootId,path)} …/>} />` 包住现有展开按钮；Popup 菜单项：展开/收起（按 `expanded` 切文案，调 `toggle`）、上传（点击触发隐藏 `<input type=file multiple>`，选完逐个 `uploadFile` 然后 `expand` + invalidate `['files','list',rootId,path]`）、复制绝对/相对位置、发送到 Agent(`sendPathToAgent(root.deviceId, path)`)。
  - **drop target**：给 DirNode 行容器加 `onDragEnter/onDragOver/onDragLeave/onDrop`（结论 3 的守卫 + ref 计数 + 高亮 `data-drag-active`），drop 时 `Array.from(e.dataTransfer.files)` 逐个 `uploadFile(rootId, path, file)`；仅 fine pointer 启用。
- **FileLeaf**（文件）：同样用 `ContextMenu.Trigger render={…}` 合并到打开按钮（若要整行含原下载区也能右键，可把 Trigger 合并到外层 `.group/file` 容器 div）。Popup 菜单项：打开(`navigate(fileRoute)`)、下载（`ContextMenu.LinkItem render={<a href={fileRawUrl(rootId,path,true)} download={name}/>}` 或编程触发）、复制绝对/相对位置、发送到 Agent。
  - **移除内联下载 `<a>` 按钮**（决策 1）。
  - **drag source**：给 FileLeaf 容器加 `draggable` + `onDragStart`（结论 2 的 `DownloadURL`，绝对 URL，`effectAllowed='copy'`）；仅 fine pointer 启用。
- 公共菜单项（复制绝对/相对、发送到 Agent）可抽一个共享的菜单内容片段，DirNode/FileLeaf 各自再追加专属项。

### 7. 文档
在 `docs/` 下按模块新增简短设计说明（文件传输/前端交互），记录上传后端契约（`POST /api/files/upload`）、`DownloadURL` 拖拽与浏览器兼容性、context-menu 封装。

## 验收（端到端）

1. **静态检查**：`bun run` 的 lint/typecheck（按仓库脚本）、`bun test`（含上传 backend：`rsyncUploadArgs` 参数顺序、`sanitizeUploadName` 穿越用例、`uploadFiles` 对 destDir 非目录/路径越界的失败码——参照现有 `device-storage`/`ssh-command` 测试风格）。**不要碰 i18n 生成文件与 `*.integration.ts`（默认不跑）**。
2. **临时实例**（严禁碰生产 tmex）：仓库内起临时 gateway，显式覆盖被 shell 继承的安装版变量（`NODE_ENV`、`TMEX_FE_DIST_DIR`、`GATEWAY_PORT`(避开 9883)、`TMEX_BIND_HOST`、`DATABASE_URL` 等），配一个 local 与一个 ssh device 的 file root。
3. **手动/无头验证**（视觉改动自验，按个人偏好用无头浏览器截图+断言）：
   - 桌面右键 / 移动端长按（真机或模拟器）均弹出菜单；菜单项齐全且按 dir/file 区分。
   - 复制绝对/相对位置写入剪贴板正确（相对位置相对树根）。
   - 发送到 Agent：目标设备出现新窗口、agent 输入框预填绝对路径、移动端 sidebar 自动展开。
   - 上传：菜单上传与"拖系统文件到文件夹 node"两条路径都成功，目录刷新出现新文件；越界/超大/非目录返回正确错误 toast。
   - 下载：菜单"下载"在所有浏览器可用；Chromium 下"拖文件 node 到桌面/Finder"落地下载（Firefox/Safari 仅菜单兜底）。

## 风险与注意

- **拖拽下载仅 Chromium**：Firefox/Safari 不支持 `DownloadURL`，菜单"下载"是唯一兜底——决策已移除内联按钮，确保菜单下载可靠。
- **编排互斥锁是模块级单例**：连点两个文件的"发送到 Agent"只有第一个生效（与 rsync 安装共用一把锁），符合预期。
- **上传不创建远端父目录**：destDir 必须已存在且是目录（已用 `statViaRsync` 校验）。
- **设备级串行队列**：上传走 `enqueueDeviceJob`，同设备文件操作串行、全局并发上限 4；大量/大文件上传会排队，属预期。
- **生产隔离**：全程禁止写入/重启本机常驻 tmex（9883 / `~/Library/Application Support/tmex/`）。
