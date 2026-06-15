# 文件列表 node 右键/长按菜单与拖拽传输

## 背景

issue #21 要求为 Files Tab 文件树的每个 node 增加右键菜单（移动端长按菜单），并补齐上传能力、拖拽下载/上传。此前文件子系统只支持只读浏览、点击打开、内联下载按钮，没有上传通道，也没有任何 HTML5 拖拽。

## 功能

每个 node 的菜单（桌面右键、移动端长按 500ms）：

- 所有 node：复制绝对位置、复制相对位置（相对树根）、发送到 Agent。
- 文件夹：展开/收起、上传文件到这个文件夹（也支持把系统文件拖到文件夹 node 上）。
- 文件：打开、下载（也支持把 node 直接拖到操作系统中下载）。

下载入口已统一收进菜单 + 拖拽，文件行不再有常显的内联下载按钮。

## 设计

### 触发：base-ui ContextMenu

封装在 `apps/fe/src/components/ui/context-menu.tsx`（参照同目录 `dropdown-menu.tsx`），底层是 `@base-ui/react/context-menu`。要点：

- `ContextMenu.Trigger` 原生同时处理桌面右键与触摸长按（500ms 硬编码，不可配），无需额外手势 hook。
- 用 `render={<button …/>}` 把触发能力合并进既有按钮，左键点击（展开目录 / 打开文件）与右键/长按菜单并存（base-ui `mergeProps` 保留原 `onClick`）。
- Popup 不能复用 dropdown 的 `w-(--anchor-width)`：右键锚点是光标处的零宽点，会把菜单压成 0 宽；改用 `min-w-44 w-auto`。

### 发送到 Agent

复用 `rsync-install-flow.ts` 既有编排，抽出通用函数 `openAgentInNewWindowWithPrompt(deviceId, promptText)`（连接设备 → 建窗 → 等就绪 → `startDraft` 预填 → 导航 → 切 agent → 移动端开 sidebar），`triggerRsyncInstall` 与新增的 `sendPathToAgent` 都是它的薄封装，共用同一把模块级互斥锁 `agentOrchestrationInProgress`。device 取 node 所属 root 的 `deviceId`。

### 下载拖到桌面

`FileLeaf` 的按钮加 `draggable` + `onDragStart`，写入 `DownloadURL` DataTransfer：`application/octet-stream:<文件名>:<绝对URL>`，绝对 URL = `window.location.origin + fileRawUrl(rootId, path, true)`。**仅 Chromium（Chrome/Edge）支持**，Firefox/Safari 静默无效；菜单"下载"项是通用兜底。移动端无系统落点，不适用。

### 上传拖到文件夹

`DirNode` 行作为 drop target：`onDragOver`/`onDrop` 均 `preventDefault`，用 `Array.from(dataTransfer.types).includes('Files')` 守卫只接管外部文件拖入（`types` 在 Firefox 是 `DOMStringList`，必须 `Array.from`），`dragenter`/`dragleave` 用 ref 计数去抖高亮。`FilesTab` 容器另加一层兜底 `preventDefault`，防止文件拖到非文件夹区域时浏览器默认打开/导航。菜单"上传"项点击隐藏 `<input type=file multiple>`。上传完成后展开该目录并失效其列表查询。

### 上传后端（反向 rsync）

此前 rsync 只有"设备 → 本机"拉取；上传是其镜像。

- `apps/gateway/src/files/ssh-command.ts`：新增 `rsyncUploadArgs(spec, localSource, remoteDest)`，与 `rsyncCopyArgs` 对称地调换源/目标、不加 `-L`。
- `apps/gateway/src/files/device-storage.ts`：新增 `sanitizeUploadName`（取最后一段，拒绝空 / `.` / `..` / 含 `/`、`\`、NUL，防穿越）与 `uploadFiles(rootId, destDir, files)`。
- 路径安全关键点：上传目标文件不存在，**不能**对目标文件跑 `checkAndNormalize`（local 分支 `realpathSync` 会因路径不存在报 `not_found`）；改为校验已存在的 `destDir`，再 `statViaRsync` 确认它是目录（否则 `not_a_directory`），最后 `posixJoin(destDir, sanitizeUploadName(name))` 拼远端路径。
- 走 `enqueueDeviceJob` 单设备串行；每文件临时落盘后 rsync 推送，cap 100MB/文件，超时 120s；失败用 `classifyRsyncFailure` 复用现有错误码。
- 路由：`POST /api/files/upload`（multipart：`rootId`、`path`=destDir、`files`），由 `handleFilesApiRequest` 分发。前端按文件逐请求上传（独立反馈，稳低于 Bun.serve 默认 128MB body 上限）。

## 接口

`POST /api/files/upload`（`multipart/form-data`）

| 字段 | 说明 |
| --- | --- |
| `rootId` | 目标 file root id |
| `path` | 目标目录绝对路径（须落在 root 内、且为已存在目录） |
| `files` | 一个或多个文件 |

成功返回 `{ uploaded: string[] }`；失败返回 `{ error, code }`（复用 `FileErrorCode`）。

## 验收

- 后端单测：`apps/gateway/src/files/ssh-command.test.ts`（`rsyncUploadArgs` 参数顺序）、`apps/gateway/src/files/upload.test.ts`（`sanitizeUploadName` 穿越用例）。
- e2e：`apps/fe/tests/files-context-menu.spec.ts` 经真实 local 设备 + rsync 验证文件/文件夹右键菜单、复制绝对/相对路径写剪贴板、菜单上传后文件出现在树中。

## 注意

- 拖拽下载仅 Chromium，菜单"下载"为唯一通用通道。
- 发送到 Agent 与 rsync 安装共用模块级互斥锁，连点多个只第一个生效。
- 上传不创建远端父目录，destDir 必须已存在。
