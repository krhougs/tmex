# 文件传输：进度/速度、取消、大文件分块、2GB 上限

> 修订（2026-06-15）：下载改为两步（prepare 流式 NDJSON 进度 + content 流式文件），修复大文件/远程下载因 Bun.serve 默认 10s 空闲超时导致的 socket hang up / 500（`apps/gateway/src/index.ts` 设 `idleTimeout: 255`；prepare 持续吐进度使连接不空闲）。Toast 同时显示**两段**进度条（上传：用户→tmex、tmex→服务器；下载：服务器→tmex、tmex→用户），文案明确各段方向。文件预览页（`FilePage.tsx`）右上角与兜底下载按钮改走应用内 `downloadFileWithProgress`（带进度 Toast），不再用 `<a download>` 直链；预览用的 `fileRawUrl`（图片/音视频/openRaw）保持不变。拖到桌面仍用单次 `GET /api/files/download`（浏览器原生）。

## 背景

上一迭代（见 `2026061409-context-menu-and-transfer.md`）补齐了上传/下载入口，但上传整文件进内存（不支持大文件）、上传/下载都无应用内进度与速度、不可取消。本迭代实现：分块上传、上传两阶段进度（含最终 rsync 段速度）、下载流式进度、取消、可配置的 2GB 单文件上限。

## 配置

- `TMEX_TRANSFER_MAX_BYTES`（默认 `2147483648` = 2GB）→ `config.transferMaxBytes`（`apps/gateway/src/config.ts`），上传下载共用。
- 经 `GET /api/system/info` 的 `SystemInfo.transferMaxBytes` 暴露给前端，上传前预校验文件大小。

## rsync 进度（跨版本）

- macOS 自带 openrsync 不支持 `--info=progress2`，但 openrsync 与 GNU rsync **都支持 `--progress`**；本项目每次 rsync 只传一个文件，单文件进度即整体进度，故统一用 `--progress`（加在 `rsyncUploadArgs`/`rsyncCopyArgs`），无需版本探测。
- `runRsync`（`apps/gateway/src/files/rsync.ts`）新增 `onProgress` 模式：增量读 stdout，按 `\r`/`\n` 切行，用 `parseRsyncProgress` 解析共有进度行 `<bytes> <pct>% <rate>/s`；并改用**空闲超时**（有进度即重置），对慢速大文件友好。

## 上传（分块 + 两阶段 + 取消）

会话模型（`transfer-session.ts` 管状态，`device-storage.pushFileToDevice` 做 rsync 推送，`api/files.ts` 接 HTTP）：

| 端点 | 作用 |
| --- | --- |
| `POST /api/files/upload/init` | 校验 destDir 是已存在目录 + `size ≤ transferMaxBytes` + 文件名消毒；建会话与临时文件；返回 `{uploadId, chunkSize}` |
| `PUT /api/files/upload/:id?offset=N` | 顺序追加 chunk 到临时文件（流式落盘，有界内存） |
| `POST /api/files/upload/:id/commit` | rsync 推送，**流式 NDJSON** 回传进度（`{type:'progress'|'done'|'error'}`），完成/失败/取消后清理 |
| `DELETE /api/files/upload/:id` | 取消：中止进行中的 rsync + 删临时文件 |

- 阶段一（浏览器→服务器）进度由前端按已发 chunk 本地计算；阶段二（服务器→设备 rsync）由 commit 流回传，**即"最终上传流"速度**。
- 每个 chunk PUT ≤ chunkSize（8MB），远低于 Bun 默认 128MB body 上限，故 2GB 文件无需调高 `maxRequestBodySize`。
- 会话懒式 GC：>30min 未完成的僵尸会话在下次 create 时清理。
- 前端 `uploadFileChunked`（`files-panel/api.ts`）串起 init→chunk→commit，`signal` 取消时 `DELETE` 会话。

## 下载（流式 + 进度 + 取消）

- `GET /api/files/download?rootId=&path=`：`pullFileFromDevice` 用 rsync 拉到 gateway 临时文件（校验 `size ≤ transferMaxBytes`），再 `Bun.file(tmp).stream()` **从磁盘流式返回**（有界内存，支持大文件），流结束/取消后删临时文件。
- 前端 `downloadFileWithProgress`：`fetch` 读响应流 → 进度/速度（阶段二 服务器→浏览器）→ `Blob` 触发 `<a download>` 保存；resolve 前为"准备中"（阶段一 设备→服务器 rsync）。`AbortSignal` 取消。
- 拖到桌面（`DownloadURL`）改指向 `/api/files/download`（浏览器原生下载，支持大文件流式，无应用内进度）。`/api/files/raw` 仍用于文件查看器内联预览（小文件）。

## 进度 Toast（`transfer-toast.tsx`）

- 每个文件一个可更新的 sonner Toast：文件名 + 阶段标签 + 进度条（`ui/progress.tsx`）+ 速度 + 取消按钮。
- **工作态 `duration: Infinity` + `dismissible: false`**：不会自动消失、也不可手动关闭，唯一中止途径是取消按钮（触发 `AbortController`）。完成后短暂停留自动消失；失败/取消保留可手动关闭。

## 验收

- 单测：`parseRsyncProgress`（openrsync/GNU 样例）、`rsyncUploadArgs`/`rsyncCopyArgs` 含 `--progress`、`transfer-session` 的 chunk offset/越界校验、`sanitizeUploadName` 穿越用例。
- e2e（`apps/fe/tests/files-context-menu.spec.ts`）：经真实 local 设备 + rsync——菜单分块上传出现进度 toast 且文件入树；菜单流式下载触发 download 事件且内容一致。
- `bun test`（gateway/shared）、FE `tsc && vite build`、biome 全绿。

## 临时文件清理与权限

- **临时目录位置/权限**：上传会话（`tmex-up-*`）与下载拉取（`tmex-dl-*`）均用 `os.tmpdir()` + `mkdtempSync`（每用户临时区，目录权限 `0700`）。`os.tmpdir()` 在 Linux(`/tmp` 或 `$TMPDIR`)/macOS(`$TMPDIR`) 均为当前用户可写，rsync 子进程同用户可读写，无跨平台权限问题；不触碰安装目录。
- **清理三重保障**（成功 / 失败 / 中断 / 取消都妥善清理）：
  1. **显式清理**：上传 commit 的 `.finally` 与流 `cancel`、`DELETE` 端点均 `removeUploadSession`（中止 rsync + 删临时）；下载流 `pull` 完成 / `cancel` / `error` 均 `cleanup`，rsync 失败/超限路径也先 `cleanup`；下载拉取成功后若构造响应流同步失败也兜底 `cleanup`。
  2. **周期 GC**：每 5min 扫描内存会话，清理 >30min 未完成的遗弃会话（如客户端关页面未发 DELETE）；定时器 `unref`，不阻塞退出。
  3. **启动孤儿扫描**：gateway 启动调用 `sweepOrphanTransferTemps()`，清理上次崩溃残留的 `tmex-up-*`/`tmex-dl-*`（>1h，多实例安全）。

## 注意 / 限制

- 下载在浏览器侧用 `Blob` 累积全部分块再保存：2GB 接近浏览器 Blob 内存上限（Chrome 通常会落盘），超大文件可能吃紧；后续可换 File System Access API 直写磁盘。
- 下载的"设备→服务器 rsync"段目前显示为"准备中"（不带逐字节速度，保持单端点简单）；如需该段速度可按上传的 prepare/commit 两步法扩展。
- 下载临时文件落在 gateway 磁盘（rsync 机制所限），靠流结束删 + 取消清理。
- 拖到桌面为浏览器原生，无应用内进度/取消。
