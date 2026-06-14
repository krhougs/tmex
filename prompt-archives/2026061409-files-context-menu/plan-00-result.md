# 执行结果：文件列表 node 右键/长按菜单 + 拖拽传输（issue #21）

## 完成情况

按 plan-00.md 全部实现并通过验证。分支：`feat/issue-21-files-context-menu`（未提交，留待人工 review）。

### i18n
- `packages/shared/src/i18n/locales/{zh_CN,en_US,ja_JP}.json` 的 `translation.files` 新增 `menu.*`、`copied`/`copyFailed`、`sendToAgent.prompt`、`upload.*`、`agentLaunch.*`；原 `install.connectFailed/windowFailed` 上移为通用 `agentLaunch.*`。
- 跑 `bun run build:i18n` 重新生成 `resources.ts`/`types.ts`（未手改）。

### 后端（上传 = 反向 rsync）
- `ssh-command.ts`：新增 `rsyncUploadArgs`（与 `rsyncCopyArgs` 对称，不加 `-L`）。
- `device-storage.ts`：新增 `sanitizeUploadName`（防穿越）与 `uploadFiles`（校验 destDir 是目录 → 逐文件临时落盘 + rsync 推送，cap 100MB/文件，串行入队，复用 `classifyRsyncFailure`）。
- `api/files.ts`：新增 `POST /api/files/upload`（multipart）。

### 前端
- 新增 `ui/context-menu.tsx`（封装 `@base-ui/react/context-menu`，Trigger 透传 render，Popup 用 `min-w-44 w-auto` 而非 `w-(--anchor-width)`）。
- `files-panel/api.ts`：新增 `uploadFile`。
- `rsync-install-flow.ts`：抽出通用 `openAgentInNewWindowWithPrompt`，锁改名 `agentOrchestrationInProgress`；新增 `sendPathToAgent` + `buildSendToAgentPrompt`；`triggerRsyncInstall` 退化薄封装。
- `files-tab.tsx`：DirNode/FileLeaf 加 ContextMenu（render 合并进现有按钮）；DirNode 作为 drop target（外部文件拖入上传，ref 计数去抖 + 容器兜底 preventDefault）+ 隐藏 file input 上传；FileLeaf 加 `draggable`+`DownloadURL` 拖到桌面下载；移除内联下载按钮；FileLeaf 改收 `root` 以拿 deviceId/rootPath；新增 `relativeToRoot`/`copyText`/`hasExternalFiles`/`CommonNodeMenuItems`。

### 决策落地（用户确认）
1. 下载移入菜单 + 拖拽，移除内联下载按钮。
2. 仅右键/长按，不加常显 ⋮ 按钮。

## 验证

- `bunx tsc -p apps/fe/tsconfig.json`：0 error；FE `tsc && vite build` 通过。
- 后端改动文件 tsc 无报错（仓库既有无关 tsc 报错与本次无关）。
- `bun test`：gateway files+api 120 pass、files 子集 43 pass（含新增 `rsyncUploadArgs`/`sanitizeUploadName` 用例）、shared 53 pass。
- e2e `apps/fe/tests/files-context-menu.spec.ts`：经真实 local 设备 + rsync，验证文件/文件夹右键菜单项、复制绝对/相对路径写剪贴板、菜单上传后文件出现在树中——通过。
- biome check 全部干净。

## 文档
`docs/files/2026061409-context-menu-and-transfer.md`。

## 遗留/边界
- 拖拽下载仅 Chromium 生效（Firefox/Safari 靠菜单"下载"兜底）；移动端拖出/拖入不适用。
- 发送到 Agent 全链路（建窗 + LLM 预填）未在 e2e 点击触发（需 provider），仅断言菜单项存在；编排逻辑复用既有已验证路径。
