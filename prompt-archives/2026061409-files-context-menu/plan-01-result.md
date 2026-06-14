# 执行结果：传输进度/速度 + 取消 + 分块 + 2GB 上限（plan-01）

按 plan-01.md 全部实现并通过验证。分支 `feat/issue-21-files-context-menu`（未提交）。

## 配置
- `config.transferMaxBytes`（`TMEX_TRANSFER_MAX_BYTES` 默认 2GB）；`SystemInfo.transferMaxBytes` + `getSystemInfo` 暴露；上传 init 与下载 stat 后端校验使用；前端经 `/api/system/info` 预校验。

## 后端
- `rsync.ts`：`runRsync` 增 `onProgress`（增量读 stdout 解析 `--progress`）+ 空闲超时；新增 `parseRsyncProgress`（openrsync/GNU 通用正则）。
- `ssh-command.ts`：`rsyncUploadArgs`/`rsyncCopyArgs` 加 `--progress`。
- `device-storage.ts`：移除旧 `uploadFiles`/`UPLOAD_MAX_BYTES`；新增 `pushFileToDevice`（带进度/signal 的反向 rsync）、`pullFileFromDevice`（拉到临时文件供流式下载，校验上限）。
- `transfer-session.ts`（新）：上传会话 Map + 临时文件 + 顺序 chunk 追加 + 懒式 GC。
- `api/files.ts`：移除旧 `POST /api/files/upload`（multipart）；新增 `upload/init`、`PUT upload/:id`、`POST upload/:id/commit`（流式 NDJSON）、`DELETE upload/:id`、`GET download`（流式）。

## 共享 + i18n
- `shared`：`SystemInfo.transferMaxBytes` + `UploadInitRequest`/`UploadInitResponse`/`UploadCommitEvent`。
- i18n 三语言新增 `files.transfer.*`（阶段标签/取消/下载完成/失败/超限）+ `build:i18n`。

## 前端
- `api.ts`：`uploadFileChunked`（init→chunk→commit NDJSON）、`downloadFileWithProgress`（fetch-stream→Blob 保存），均带 `AbortSignal`；`format.ts`（字节/速率格式化）；`fileUrl.fileDownloadUrl`。
- `ui/progress.tsx`（极简进度条）；`transfer-toast.tsx`（工作态 `duration:Infinity`+`dismissible:false`+取消按钮，完成后放开）。
- `files-tab.tsx`：`doUpload` 改分块 + 进度 toast + 上传前 `transferMaxBytes` 预校验；下载菜单项改应用内流式下载 + toast；拖到桌面改指向 `/api/files/download`；`TreeContext.transferMaxBytes` 由 `/api/system/info` query 提供。

## 验证（均通过）
- FE `tsc -p apps/fe`：0 error；FE `tsc && vite build` 通过。
- 后端改动文件 tsc 无报错。
- `bun test`：gateway files 48 pass（含 `parseRsyncProgress`/`rsyncUploadArgs`/`rsyncCopyArgs`/`transfer-session`/`sanitizeUploadName`）、files+api 124 pass、shared 53 pass。
- e2e `files-context-menu.spec.ts`：3 passed——① 右键菜单/复制路径/分块上传出现进度 toast 且文件入树；② 菜单应用内流式下载触发 download 事件且内容一致；③ 上传进行中的 toast 不自动消失（duration:Infinity）、无关闭按钮（dismissible:false，Escape 不关闭）、取消按钮可用。
- 取消健壮性：`uploadFileChunked` 在每个 chunk 前与 commit 前加 `ensureNotAborted()` 守卫，取消后不再触发后续上传/推送。
- biome 全绿。

## 临时文件清理与权限（用户追加要求）
- 临时目录统一 `os.tmpdir()` + `mkdtempSync`（`0700`，跨平台可写，rsync 同用户可读写，不碰安装目录）。
- 清理三重保障：① 显式清理（上传 commit `.finally`/流 cancel/`DELETE`；下载 pull-done/cancel/error/rsync 失败/构造失败兜底）；② 周期 GC（5min 扫描，清 >30min 遗弃会话，`unref`）；③ 启动孤儿扫描 `sweepOrphanTransferTemps()`（清 >1h 的 `tmex-up-*`/`tmex-dl-*` 崩溃残留，runtime 启动调用）。
- 新增/改动：`transfer-session.ts`（周期 GC + `sweepOrphanTransferTemps`）、`runtime.ts`（启动调用）、`api/files.ts`（download 构造失败兜底 cleanup）；单测 `transfer-session.test.ts` 覆盖孤儿扫描"仅清超期、保留新建、不动非前缀"。

## 补充说明（用户强调项）
- 进行中传输 toast 的"不自动消失 + 工作态禁止手动 dismiss"由 sonner `duration:Infinity` + `dismissible:false` 实现，并由 e2e 用「拖住 chunk PUT 保持工作态」确定性验证。
- 对 local 设备 + 极小文件，rsync 推送瞬时原子，"取消阻止落盘"取决于取消时机；真实远程/大文件场景由 AbortController→fetch abort→后端 `DELETE`（中止 rsync + 删临时）+ commit 流 cancel 共同保证。

## 文档
`docs/files/2026061500-transfer-progress-chunked.md`。

## 限制（已记录于文档）
- 下载浏览器侧用 Blob 累积，超大文件吃内存（后续可换 File System Access API）。
- 下载"设备→服务器 rsync"段显示为"准备中"（无逐字节速度）；如需可按上传两步法扩展。
- 拖到桌面为浏览器原生，无应用内进度/取消。
