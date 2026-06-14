# Files SSH/rsync 支持与体验优化（plan-00）

承接 2026061404-files-tab。本地文件浏览已上线，本轮扩展 SSH + 体验优化。

## 核心架构决策

**rsync 作为统一文件传输层**（design A）。理由：req4 要求「无论本地还是远程设备 rsync 未安装都给错误 +
按设备创建窗口装 rsync」，只有当本地设备的文件访问也走 rsync 时，这套「按设备」的逻辑才对本地设备成立。
- 本地设备：`rsync --list-only /localpath/`、读取用 `rsync /localpath/file <tmp>`（rsync 操作本地路径）。
- SSH 设备：`rsync --list-only -e <ssh-cmd> user@host:/path/`、读取同理。
- req2「本地设备按本地文件读取」理解为：本地设备的 rsync 操作的是本地文件路径（无 ssh 传输），与
  ssh 设备的 rsync-over-ssh 相对。

宿主机为 openrsync（macOS）/GNU rsync（Linux 生产）。`--list-only`（`LC_ALL=C`）输出
`<perms> <size> <YYYY/MM/DD> <HH:MM:SS> <name>`，首行 `.` 为目录自身，`l` 前缀为符号链接，
GNU 还会 `name -> target`、size 可能带逗号——解析器需兼容两者。

## 子系统接入要点（探索已核实）

- SSH 鉴权：`resolveSshConnectConfig(device, decrypt, deps)`（ssh-connect-config.ts）；
  `decrypt`（crypto）；`quoteShellArg/joinShellArgs`（tmux-client/command-builder.ts）；
  `resolveSshUsername/resolveSshAgentSocket`（tmux/ssh-auth.ts）；gateway 进程有 SSH_AUTH_SOCK。
  authMode→ssh cmd：key=解密 PEM 落临时文件 0600 + `ssh -i`；agent=SSH_AUTH_SOCK 透传；
  configRef=走 ~/.ssh/config（host alias）；password=rsync 不支持（明确报错）；auto=agent/key 优先。
- 子进程：`Bun.spawn(argv,{env,stdout:'pipe',stderr:'pipe'})` + `new Response(p.stdout).text()` +
  `p.exited`；超时 `setTimeout`→`p.kill()`。per-device 串行队列仿 ssh-external-connection 的
  commandQueue（Promise 链 + catch 吞错），外加全局并发上限。
- 建窗：`useTmuxStore.createWindow(deviceId,name?)`（tmux.ts:554）发 WS、记 pendingCreateWindowAt，
  **不返回新 window id**。需 snapshot 前后 diff 找新窗口（已有 pendingNavigationRef 只等已知 id）。
  control-mode→snapshot 延迟 ~250-300ms。
- agent draft：`startDraft(deviceId,paneId,paneTitle)`（agent.ts:1031）无 prompt 预填；
  `handleCreateSessionForPane`（sidebar-device-list.tsx:228）= navigateToPane+startDraft+setSidebarTab('agent')
  现成范式；ChatInput text 独立于 draft，需扩 DraftSession.prompt + useEffect setText。
  手动发送 = handleSend→materializeDraft→createSession→sendMessage。
- 设置范式：llm-provider-row.tsx（Switch+toggle mutation）、llm-provider-form-modal.tsx（Dialog+form+mutation）。
- 持久化：zustand persist + partialize（ui.ts），file-tree 加 persist（name 'tmex-file-tree'，
  partialize {expanded}）。
- toast：`const id = toast.error(msg,{action:{label,onClick}})`；`toast.dismiss(id)` 主动清。
  toast action onClick 在 portal 外，无法用 useSidebar/useNavigate 的 context → 用 bridge。

## 设计

### 后端（apps/gateway/src/files/）
- `ssh-command.ts`：`buildDeviceRsyncTarget(device, decrypt): Promise<{ remotePrefix; rsyncEnv; rsyncRshArg?; cleanup }>`。
  local → remotePrefix=''（本地路径直接用）；ssh → 构造 `-e "ssh -p .. -i ..|-o ..."` + `user@host:` 前缀；
  password authMode → 抛 unsupported。临时密钥文件 0600 + cleanup 删除。
- `rsync.ts`：`runRsync(argv, {env,timeoutMs,signal})`→{stdout,stderr,exitCode}；
  `parseListOnly(stdout)`→FileEntry[]（兼容 openrsync/GNU，LC_ALL=C，跳过 `.`/`..`，symlink 去 `-> target`，
  size 去逗号）；`copyToTemp(target)`；`classifyRsyncError(exitCode,stderr)`→
  rsync_missing_local|rsync_missing_remote|connection_failed|permission|not_found|generic。
- `queue.ts`：`enqueue(deviceId, job, {timeoutMs})`，per-device 串行 + 全局并发上限（如 4），超时 kill。
- `device-storage.ts`：`listDirectory(device, root, path)`、`readTextFile(...)`、`statFile(...)`、
  `rawFilePath(...)`（返回本地临时文件路径供 Bun.file 流式下载）。路径安全：local realpath-contain；
  ssh 文本归一化 contain（禁 `..` 逃逸）。所有走 queue。
- `db/schema.ts` fileRoots：+`deviceId`(FK cascade)、+`enabled`、unique(deviceId,path)。迁移（drizzle
  生成；旧 home seed 行清空——本特性未发版，数据可丢）。`ensureFileRootsInitialized` 不再 seed（需 device）。
- `db/file-roots.ts`：FileRootRecord+deviceId/enabled；getFileRoots(按 device 过滤+enabled)、
  getFileRootById、createFileRoot(deviceId,path,enabled)、updateFileRoot(id,{path?,enabled?,sortOrder?})、
  deleteFileRoot。
- `api/files.ts`：roots CRUD（create/update/patch-enable/delete，校验 device 存在 + path 绝对）；
  list/content/stat/raw 改为按 rootId（或 deviceId+path）路由；错误码透传（含 rsync_missing_*）。
- 安全：每 device 白名单独立；ssh 残留 symlink 逃逸属用户自有设备，归一化 + 前缀约束即可。

### 共享（packages/shared）
FileRootDto +deviceId/deviceName/deviceType/enabled；CreateFileRootRequest/UpdateFileRootRequest；
FileErrorCode 枚举；list/content/stat/raw 响应不变（含 deviceId 透传到 ref）。

### 前端（apps/fe）
- `utils/fileUrl.ts`：ref 改为编码 {deviceId, path}（base64url）；filesApi/fileRawUrl 带 deviceId。
- `stores/file-tree.ts`：加 persist（{expanded}）。
- `components/files-panel/`：
  - api.ts：roots/list/content/stat/raw 带 deviceId；CRUD roots；FileApiError.code。
  - files-tab.tsx：按 device 分组的多根树；懒加载（默认不监听未展开根）；展开根才发请求；
    每节点错误态（permission/not_found/device_missing/root_disabled/conn_failed/rsync_missing）；
    收起+展开=重试（防抖）；展开态持久化；rsync_missing 显示 toast + 安装按钮（仅当配置过 LLM）。
  - rsync-install-flow.ts + flow-bridges：toast 安装按钮 onClick→立即 dismiss toast→编排：
    确保设备连接→createWindow→waitForNewWindow(snapshot diff,超时)→navigate→startDraft(预填 prompt)→
    setSidebarTab('agent')→手机 setOpenMobile(true)。模块级 lock 防打断，一次性。
- `components/settings/files-tab.tsx`：仿 llm-providers——列表行（Switch 启用、编辑、删除）+ 增/改 Dialog
  modal（设备选择 + 路径 + 启用开关）。
- `pages/FilePage.tsx`：从 ref 解 {deviceId, path}；其余不变。
- i18n en/zh/ja 全量新增。

### 队列/生命周期（req5）
- 后端 per-device 串行 + 全局并发上限 + 超时 kill，避免 IO 打爆。
- 前端展开根才查；refetch 用 window-focus + 适中 interval（30s，仅展开 dir，背景不刷）+ React Query 去重。
- 窗口生命周期：install flow 自带 waitForNewWindow + 超时 + lock；设备/根消失时前端剪枝（沿用上轮 reconcile）。

## 验收
- 设置：每根独立 modal 增改 + 启用开关 + 绑定设备；列表风格同 llm-providers。
- 本地根经 rsync 列目录/读文件/下载正常；树展开态浏览器持久化；未展开根不发请求。
- 各边界错误有清晰节点态；收起+展开可重试且防抖。
- rsync 缺失：本地/远程都报错；配置过 LLM 时有安装按钮；点击→清 toast→建窗→跳 agent 预填 prompt→
  等待手动发送；时序正确不被打断；手机强开 sidebar。
- 后端：rsync 解析/ssh-cmd/队列/路径安全单测全过；typecheck/build 通过；本地 rsync 临时实例 smoke。

## 风险/注意
- password authMode 的 rsync：不支持，明确报错（不静默失败）。
- 临时密钥文件 0600 + 唯一名 + 及时清理；子进程 env 过滤敏感键（同 buildLocalTmuxEnv）。
- ssh 测试受限（本机 localhost ssh 不可用）：ssh-cmd 构造 + rsync 解析做单测，local rsync 做实测。
- 迁移：fileRoots 加 NOT NULL deviceId，旧 seed 行清空（未发版，可丢）。
- 不碰生产；临时实例端口/DB 显式覆盖。
