# Files SSH/rsync 支持与体验优化 — 结果总结（plan-00-result）

实现于 2026-06-14，对应 plan-00。goal 5 点全部完成并通过验证。

## 核心架构

**rsync 作为统一文件传输层**：本地设备对本地路径跑 rsync，SSH 设备跑 rsync over ssh。每个 file root
绑定到一个设备（local/ssh）+ 独立启用开关。这样 req4「无论本地/远程 rsync 未安装都按设备装」对两类
设备都成立。

## 交付内容

### 后端（apps/gateway/src/files/）
- `categorize.ts`：类别/MIME（从旧 service.ts 抽出）。
- `rsync.ts`：`runRsync`（Bun.spawn + LC_ALL=C + 超时 kill + AbortSignal + 子进程 env 过滤敏感键）、
  `parseListOnly`（兼容 openrsync/GNU，跳过 `.`/`..`、symlink 去 `-> target`、size 去逗号）、
  `classifyRsyncFailure`（exit/stderr → rsync_missing_remote/connection_failed/permission_denied/
  not_found/timeout/...）、`RsyncMissingLocalError`（spawn ENOENT → 本地缺 rsync）。
- `ssh-command.ts`：`buildRsyncDeviceSpec(device, decrypt, resolveConfig)` 复用 `resolveSshConnectConfig`——
  local→空前缀；configRef→ssh alias 走 ~/.ssh/config；key→解密 PEM 落临时 0600 文件 + `ssh -i`，完成 cleanup；
  agent→SSH_AUTH_SOCK 透传；password/passphrase-key 无 agent→`auth_unsupported`。`rsyncList/CopyArgs`
  （copy 加 `-L` 跟随符号链接、ssh 远端路径单引号防切分）。
- `queue.ts`：`enqueueDeviceJob`——每设备串行（Promise 链）+ 全局并发上限 4，防 IO 打爆。
- `device-storage.ts`：`listDirectory/statFile/readTextFile/readRawFile`，按 rootId→device 路由；
  路径安全 `checkAndNormalize`（local realpath 防 symlink 逃逸 + 文本含包；ssh 纯文本归一化含包）；
  全部经 queue；读文件先 stat 限大小再 copy-to-temp；raw 读入 buffer（50MB 上限）。
- `db/schema.ts` + 迁移 `0008`：fileRoots 加 `deviceId`(FK cascade) + `enabled`，unique(deviceId,path)；
  迁移含 `DELETE FROM file_roots`（清旧无设备占位，未发版可丢）。`db/file-roots.ts`：CRUD（含 update/toggle）。
  移除 runtime.ts 的 ensureFileRootsInitialized（根需设备，不再 seed）。
- `api/files.ts`：roots CRUD（POST/PATCH/DELETE，校验设备存在 + 路径绝对 + 去重）；list/content/stat/raw
  按 `rootId+path` 路由；错误统一 `{ error, code }`（前端按 code 渲染）。
- 单测：`rsync.test.ts`（解析/分类）、`ssh-command.test.ts`（各 authMode spec + arg builder + 临时密钥
  落盘/清理）、`queue.test.ts`（串行/失败不阻断/全局并发≤4）、`path-safety.test.ts`（local realpath
  逃逸 + ssh 文本含包 + sibling-prefix 防误判）——共 35 例。

### 共享（packages/shared）
`FileErrorCode` 枚举、`FileRootDto`（+deviceId/deviceName/deviceType/enabled/sortOrder）、
`CreateFileRootRequest/UpdateFileRootRequest/FileRootResponse`。

### 前端（apps/fe）
- `utils/fileUrl.ts`：ref 编码 `{rootId, path}`；filesApiUrl/fileRawUrl 带 rootId。
- `stores/file-tree.ts`：**persist**（localStorage `tmex-file-tree`，{expanded}），复合键 (rootId,path)，
  `pruneRoot/pruneStaleRoots` 剪枝。
- `lib/flow-bridges.ts` + `components/flow-bridges.tsx`：navigate / 手机 sidebar 桥接（供 toast 回调用），
  挂在 RootLayout（RouterProvider+SidebarProvider 内）。
- `components/files-panel/`：
  - `api.ts`：roots CRUD + list/content/stat（rootId）+ `FileApiError.code`。
  - `files-tab.tsx`：按设备绑定的多根树（root 带设备徽标）；**懒加载**（未展开根不发请求）；**持久化展开**；
    每节点错误态（按 code 本地化 + 重试按钮）；**收起+展开重试**（staleTime 2000 防抖）；健康目录 30s 轮询、
    出错即停轮询（IO 安全）；reconcile 剪枝；rsync 缺失→弹带「安装」按钮的 toast（仅配置过 LLM）。
  - `rsync-install-flow.ts`：`triggerRsyncInstall`——模块级锁（一次性不被打断）→ 确保设备连接 →
    建窗 → **snapshot diff 等新窗口就绪** → startDraft(预填 prompt) → 导航 → 切 agent tab → 手机强开 sidebar。
- `stores/agent.ts`：`DraftSession.prompt` + `startDraft(...prompt)`；`agent-tab.tsx` ChatInput 用 ref
  消费一次预填 prompt（等用户手动发送）。
- `pages/FilePage.tsx`：解 `{rootId, path}`，按类别分发，下载/raw 带 rootId。
- `settings/files-tab.tsx`（子代理实现）：仿 llm-providers——列表行 Switch 启用 + 编辑/删除，增/改单独
  Dialog modal（设备 Select + 路径 + 启用），AlertDialog 删除确认。
- i18n：`files.error.*`（全 FileErrorCode）、`files.install.*`、`files.retry`、`settings.files.*`（重构）、
  `apiError.fileRootDeviceInvalid/Duplicate`（en/zh/ja）+ build:i18n。

## 验证（全绿）
- gateway 单测 **563 pass / 0 fail**（含 35 新 files 例）；新后端文件 tsc + biome clean。
- FE tsc + `bun run build` 通过；24 个新/改文件 biome clean（main.tsx 仅剩 HEAD 既有 useExhaustiveDependencies）。
- **本地设备 rsync 端到端 smoke**（NODE_ENV=test + 临时库 + 19772，不碰生产）：建本地设备 + 绑定根 →
  list（rsync 解析、目录优先、size 正确）/stat/content（copy-to-temp）正常；binary 415；download
  Content-Disposition；**安全：/etc 403、穿越 403；禁用根 → 403 + code root_disabled**。
- **浏览器 smoke**（playwright，dist + /api 代理）：Files 树（设备徽标 localhost）、展开、markdown 预览
  （rsync 取内容）、设置 Files 的 modal 化 UX（Switch + 设备徽标 + 编辑/删除 + Add directory）均通过，截图核验。

## 注意 / 局限
- SSH 路径受限于本机无 localhost sshd：ssh-cmd 构造 + rsync 输出解析 + 错误分类做单测覆盖；
  rsync-install 编排逻辑接的都是已验证的 store API（connectDevice/createWindow/startDraft）+ 桥接，
  typecheck 通过；安装按钮在未配置 LLM 时正确隐藏（截图已证）。完整的「点击安装→建窗→agent 预填」
  端到端需真实 SSH host + LLM 凭证，未在本机闭环。
- password authMode 的 rsync 明确不支持（auth_unsupported），passphrase 私钥需 ssh-agent。
- raw/content 走 copy-to-temp（rsync 不便流式）；raw 50MB、文本 2MB 上限。
- 迁移源真值 `apps/gateway/drizzle/0008_*.sql` 已就位；`packages/app/resources/gateway-drizzle` 为
  gitignore 产物，发版 build 自动同步。
- 不碰生产；临时实例端口/DB 显式覆盖，repo tmex.db 未动。

## 修订（2026-06-14 同日反馈修复）

用户反馈三点，均已修复 + 验证：

1. **展开远程树根无 loading**：`DirNode` loading 行加了 `Loader2` 旋转图标，并扩到
   `query.isLoading || (query.isFetching && !query.data)`，加载态更显眼。
2. **展开后内容闪一下就自己收起（需再点一次）**：根因是 `files-tab.tsx` reconcile 的
   `parentOf(p) === path` 在 `path === '/'` 时会把根自身误判为「直接子目录」（`parentOf('/') === '/'`）
   而 collapse，导致根 `/` 加载完成后自我折叠。用 playwright + 人工 1.5s 延迟 + 在 store collapse 打
   stack trace 复现确认（root `/` 在 t=1500ms 触发 `COLLAPSE rootId\n/`）。修复：reconcile 增加
   `p !== path` 守卫，只剪「直接子目录」永不剪自身。验证：修复后 root `/` 全程保持展开、loading 正常、
   内容稳定显示、0 collapse trace。
3. **password 认证可实现**：用 `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force`（OpenSSH 8.4+，无需 sshpass
   等额外二进制）。`ssh-command.ts` 新增 `setupAskpass(secret)`：临时 0700 脚本从 env 读密钥喂给 ssh 的
   password/passphrase 提示。password authMode 不再报错，且 **passphrase 私钥也顺带支持**（之前不支持）。
   非 askpass 分支（key/agent/configRef）保留 `BatchMode=yes`；askpass 分支去掉 BatchMode 并加
   `PreferredAuthentications=password,keyboard-interactive`。单测覆盖 password/passphrase 的 askpass
   spec + 清理；gateway 全量 **564 pass**。
