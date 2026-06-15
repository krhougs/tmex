# 文件传输进度/速度 + 取消 + 大文件分块 + 2GB 上限（issue #21 续）

## Context

上一轮（已完成、已合并到分支 `feat/issue-21-files-context-menu`）做了文件树右键/长按菜单 + 基础上传（单次 multipart，整文件进内存）+ 拖拽下载。现状：上传/下载**没有任何应用内进度条、速度显示、取消**，上传整文件进内存（无法支撑大文件），下载先把整个文件 rsync 拉到 gateway 内存再一次性返回（慢的 rsync 段对用户是无反馈等待）。

本轮目标（用户明确要求"一步到位"）：
1. **上传**：分块（chunk）流式上传支持大文件；显示**两阶段**进度——浏览器→服务器、服务器→设备(rsync)，**以最终 rsync 段速度为主**；可取消。
2. **下载**：流式（不再整文件进内存），显示进度+速度，可取消。
3. **文件大小上限 2GB**，由**环境变量配置**，在**后端操作校验**时使用，并暴露给前端做上传前预校验。
4. 进度/速度/取消的 UI：**每个文件一个可更新的 sonner Toast**（进度条 + 速度 + 阶段标签 + 取消按钮）。

## 关键技术结论（已核实，禁止再凭记忆改）

- **rsync 进度跨版本**：macOS 自带 **openrsync 不支持 `--info=progress2`**，但 openrsync 与 GNU rsync **都支持 `--progress`**。由于我们**每次 rsync 只传一个文件**，"单文件进度"=整体进度。统一用 `--progress`，正则匹配两者共有的进度行 `<bytes> <pct>% <rate>/s <time>` 即可，**无需版本探测**。进度由 gateway 本机 rsync 打印（与远端版本无关）。
- **进度行实时读取**：`runRsync`（`apps/gateway/src/files/rsync.ts:40`）当前用 `new Response(proc.stdout).text()` 一次性读完。需增量读 `proc.stdout.getReader()` 按 `\r`/`\n` 切行回调（参考 `tmux-client/local-external-connection.ts` 的增量读法）。`opts.signal` kill 进程已支持（rsync.ts:69）。大文件需把固定 timeout 改成**空闲超时**（有进度就重置计时器）。
- **进度回传通道**：用**流式 HTTP 响应（NDJSON）**，不用 Borsh WS。理由：请求作用域天然、无需新增 Borsh schema/store 接线、取消=abort fetch + 一个 cancel 端点。Bun.serve 已支持 `new Response(ReadableStream)`（rsync.ts:80 即在用）。
- **分块无需提高 body 上限**：每个 chunk PUT ≤ chunkSize（8MB）< Bun 默认 128MB；2GB 文件靠多次小请求，不动 `maxRequestBodySize`。
- **配置体系**：`apps/gateway/src/config.ts` 用 `getEnv` 解析 `TMEX_*` 环境变量并给默认值；`bootstrap-env` 先于 config 加载。`loadEnv()` 无需改（自动认 `TMEX_*`）。前端经 `GET /api/system/info`（`apps/gateway/src/system/index.ts:12` 的 `getSystemInfo`，类型 `SystemInfo` 在 `packages/shared/src/index.ts:38`）拿配置，前端已有消费方 `apps/fe/src/components/settings/version-tab.tsx:55`。
- **设备串行/并发**：`enqueueDeviceJob`（queue.ts）继续用于 rsync 推/拉。`sanitizeUploadName`、`checkAndNormalize`、临时目录模式复用现有。

## 设计

### 配置（2GB 上限）
- `config.ts` 新增 `transferMaxBytes: Number.parseInt(getEnv('TMEX_TRANSFER_MAX_BYTES', '2147483648'), 10)`（2GB，上传下载共用）。
- `SystemInfo` 加 `transferMaxBytes: number`，`getSystemInfo()` 返回 `config.transferMaxBytes`。
- `device-storage.ts` 删除硬编码 `UPLOAD_MAX_BYTES`，校验改用 `config.transferMaxBytes`；下载侧 stat 后同样校验。预览用的 `RAW_MAX_BYTES`/`MAX_TEXT_BYTES` 不动（小文件内联预览）。

### rsync 层
- `rsync.ts`：`runRsync` 增加可选 `onProgress?: (p: {transferred:number; pct:number; rate:string}) => void`；提供时走增量读 stdout + 按行解析；`idleTimeoutMs`（有进度重置）。新增导出 `parseRsyncProgress(line)`。
- `ssh-command.ts`：`rsyncUploadArgs`、`rsyncCopyArgs`（下载）开头加 `--progress`（更新对应单测期望）。

### 上传（分块 + 两阶段进度 + 取消）
后端 session 模型（`apps/gateway/src/files/transfer.ts` 新建，或扩 device-storage）：
- `POST /api/files/upload/init` `{rootId,path(destDir),name,size}` → 校验：rootId 解析、destDir 落在 root 内且**是已存在目录**（`enqueueDeviceJob`+`statViaRsync`，**fail-fast 在上传前**）、`sanitizeUploadName`、`size ≤ transferMaxBytes`；`mkdtemp` 建临时文件；返回 `{uploadId, chunkSize}`。session 存 `{tmpPath, rootId, destDir, name, size, received, abort:AbortController, createdAt}`。
- `PUT /api/files/upload/:id`（body=chunk，header/query 带 offset）→ 校验 `offset===received` 且不超 size/cap，追加写临时文件（`appendFileSync`/writer），更新 received。
- `POST /api/files/upload/:id/commit` → 校验 received===size → 返回**流式 NDJSON**：`enqueueDeviceJob` 内 `runRsync(rsyncUploadArgs, {onProgress, signal:session.abort.signal})` 把每次进度 enqueue 成一行 `{phase:'device',pct,rate,transferred}`；成功末行 `{done:true,uploaded}`；清理 temp+session。
- `DELETE /api/files/upload/:id` → `session.abort.abort()`（kill 进行中 rsync）+ 删 temp + 删 session。
- 模块级 session Map + 定时 GC（清理 >30min 的僵尸 session 及其 temp）。
- 阶段一（浏览器→服务器）进度：**客户端本地**按已发 chunk 数计算，无需服务端推。

前端 `apps/fe/src/components/files-panel/api.ts`：`uploadFileChunked(rootId,destDir,file,{onProgress,signal})` → init → 顺序 PUT 各 chunk（每次 `onProgress({phase:'upload',sent,total})`）→ POST commit 读 `response.body.getReader()` 解析 NDJSON（`onProgress({phase:'device',...})`）。`signal` abort 时停止并 `DELETE` session。

### 下载（流式 + 进度 + 取消）
- `GET /api/files/download?rootId=&path=` → `enqueueDeviceJob`：`statViaRsync` 校验非目录且 `size ≤ transferMaxBytes` → rsync 拉到 gateway 临时文件（leg A，期间 fetch 处于 pending = 前端显示"设备准备中…"）→ `new Response(Bun.file(tmp).stream(), {headers: Content-Length/Type/Disposition})` 从磁盘流式返回（**有界内存**，支持 2GB）；流结束后删 temp。`req.signal` 透传给 rsync 以支持中止（Bun 客户端断开 → abort；兜底靠 TTL 清理）。
- 前端 `downloadFileWithProgress(rootId,path,name,{onProgress,signal})`：`fetch(url,{signal})` → resolve 前显示"准备中"（leg A）→ 读 `response.body.getReader()` 累积分块、按 Content-Length 算 `{phase:'download',pct,rate}`（leg B）→ `Blob`→ objectURL → `<a download>` 触发保存 → revoke。
- 菜单"下载"改调 `downloadFileWithProgress`（替换现 `<a download>` LinkItem）。**拖到桌面**的 `DownloadURL` 改指向新 `GET /api/files/download`（浏览器原生下载，支持大文件流式，OS 自带进度，无应用内进度）。`/api/files/raw` 保留给文件查看器内联预览（小文件）。

### 进度 Toast UI
- 新增极简进度条（`apps/fe/src/components/ui/progress.tsx`，shadcn 风格的 div 宽度百分比即可）。
- 新增 `apps/fe/src/components/files-panel/transfer-toast.tsx`：`startTransferToast(title)` 返回 `{update(phase,pct,rate), success(), fail(msg), close()}`，内部用 sonner `toast.custom`/按 id 更新，渲染：文件名 + 阶段标签（上传到服务器 / 传到设备 / 准备中 / 下载中）+ 进度条 + 速度 + **取消按钮**（触发该 transfer 的 AbortController）。i18n 加对应文案。
- **进行中的 toast 不可自动消失、也不可手动 dismiss**：工作态用 `toast(..., { id, duration: Infinity, dismissible: false })`，唯一中止途径是 toast 内的取消按钮（触发 AbortController）。仅当**完成/失败/已取消**后才放开：成功态短暂停留后自动消失（如 `duration` 数秒、`dismissible: true`），失败/取消态保留并允许手动关闭。需确认 sonner 的 `duration: Infinity` + `dismissible: false` 行为符合预期。
- `files-tab.tsx`：`doUpload` 改用 `uploadFileChunked` + transfer toast；上传前用 `transferMaxBytes`（react-query 取 `/api/system/info`）预校验大小并提示。下载菜单项接 `downloadFileWithProgress` + transfer toast。每个文件一个 AbortController，取消按钮调用之。

## 关键文件
- 后端：`apps/gateway/src/config.ts`、`apps/gateway/src/system/index.ts`、`apps/gateway/src/files/rsync.ts`、`apps/gateway/src/files/ssh-command.ts`、`apps/gateway/src/files/device-storage.ts`、新建 `apps/gateway/src/files/transfer.ts`、`apps/gateway/src/api/files.ts`。
- 共享：`packages/shared/src/index.ts`（`SystemInfo.transferMaxBytes`、上传 init/commit/进度类型）、`packages/shared/src/i18n/locales/*.json`（+ `build:i18n`）。
- 前端：`apps/fe/src/components/files-panel/api.ts`、新建 `transfer-toast.tsx`、新建 `ui/progress.tsx`、`files-tab.tsx`。
- env：`development.env`、`test.env` 增 `TMEX_TRANSFER_MAX_BYTES`（可选；不加则用默认 2GB）。

## 验收
- 单测：`parseRsyncProgress`（openrsync 与 GNU 样例行各一）；`rsyncUploadArgs`/`rsyncCopyArgs` 含 `--progress`（更新现有期望）；上传 session 的 init 校验（超 2GB→`too_large`、destDir 非目录→`not_a_directory`、文件名穿越→`invalid`）与 chunk offset 校验。
- `bun test`（gateway/shared）、FE `tsc && vite build`、biome 全绿；**不碰** i18n 生成文件与生产 tmex。
- e2e（扩 `apps/fe/tests/files-context-menu.spec.ts` 或新建）：经真实 local 设备 + rsync——
  - 菜单/拖拽上传一个文件：出现进度 toast → 完成 → 文件出现在树中（沿用现有断言，验证分块流程不回归）。断言进行中的 toast 不会自动消失、且无法手动 dismiss（工作态点 dismiss 无效、仅取消按钮可终止）。
  - 菜单下载：触发 Playwright `download` 事件并保存成功。
  - 上传超过（临时调小的）`TMEX_TRANSFER_MAX_BYTES` → 前端预校验拦截/后端返回 `too_large`。
- 临时实例验证：仓库内起 gateway，显式覆盖被 shell 继承的安装版 env（`NODE_ENV`/`TMEX_FE_DIST_DIR`/`GATEWAY_PORT` 避开 9883/`DATABASE_URL` 等），配 local + ssh device 各一，手测大文件分块上传的两阶段速度、下载速度、取消。

## 风险与注意
- 下载会先把整个文件 rsync 到 gateway 临时磁盘再流给浏览器（rsync 机制所限）；gateway 需有临时磁盘空间，务必可靠清理（流结束删 + TTL 兜底）。
- 下载的 leg A（设备→服务器 rsync）目前显示为"准备中"（不带逐字节速度，保持单端点简单）；如需下载也显示 rsync 段速度，可后续按上传的 prepare/commit 两步法扩展。
- 拖到桌面下载为浏览器原生，无应用内进度/取消（OS 行为）。
- session/temp 必须 GC，避免中断上传留下僵尸临时文件。
- 先存档：开工前在 `prompt-archives/2026061409-files-context-menu/` 追加本轮 prompt 到 `plan-prompt.md`，存 `plan-01.md`（本计划）；完成后写 `plan-01-result.md`。
