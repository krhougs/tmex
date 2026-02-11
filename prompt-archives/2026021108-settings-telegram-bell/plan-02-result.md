# Plan 02 执行结果

时间：2026-02-11

## 变更概览

### 1. 编辑器未发送内容持久化
- 在 `apps/fe/src/stores/ui.ts` 增加 `editorDrafts`、`setEditorDraft`、`removeEditorDraft`，并纳入 `tmex-ui` 持久化。
- 在 `apps/fe/src/pages/DevicePage.tsx` 增加按 `deviceId:paneId` 粒度的草稿键。
- 编辑器输入时实时写入草稿；切换 pane 或刷新后自动回填；发送/逐行发送/清空后清除草稿。

### 2. Pane 关闭提示降噪
- 在 `apps/fe/src/pages/DevicePage.tsx` 将 `invalidSelectionMessage` 的 toast 改为延迟触发（500ms）。
- 引入 key 去重与状态回查，避免页面切换过程中的瞬态误报。

### 3. 侧边栏底部按钮改为独立成行
- 在 `apps/fe/src/components/Sidebar.tsx` 将底部按钮容器由单行双列改为纵向双行（管理设备、设置）。
- 折叠态仍保持纵向图标按钮。

### 4. 设备管理支持修改设备
- 在 `apps/fe/src/pages/DevicesPage.tsx` 新增设备卡片“修改设备”入口。
- 新增复用式 `DeviceDialog`，支持 `create/edit` 两种模式。
- 编辑走 `PATCH /api/devices/:id`，成功后刷新列表并 toast。

### 5. 本地设备隐藏认证相关输入
- 在新增/修改表单中，仅 `SSH` 类型显示认证方式和密码/私钥输入区。
- `local` 类型提交时统一使用 `authMode='auto'`。

### 6. 对应 E2E 用例同步
- 移除本地设备创建步骤中对“认证方式”下拉的依赖（多个 e2e 文件同步）。

## 验证结果

### TypeScript
- `bunx tsc -p apps/fe/tsconfig.json --noEmit` ✅

### E2E
- `bun run --cwd apps/fe test:e2e -- tests/tmux-mobile.e2e.spec.ts -g "iPhone 尺寸下顶栏不应挤在一起"` ✅
- `/usr/bin/zsh -lc 'source ~/.zshrc >/dev/null 2>&1 || true; bun run --cwd apps/fe test:e2e -- tests/tmux-terminal.e2e.spec.ts -g "跳转到最新按钮应工作正常|当前 pane 被关闭后应显示失效态并禁用跳转到最新按钮|终端页面应更新浏览器标题"'` ✅（3/3）
- `tests/tmux-local.e2e.spec.ts` 在当前环境存在端口探测失败（`Could not find available port starting from 9663`），未完成该项自动化验证。

## 结论

本轮 5 项需求均已完成实现：
1. 输入框未发送内容可跨刷新/切页保留。
2. pane 关闭提示显著降噪。
3. 管理设备与设置按钮改为独立成行。
4. 设备管理已支持修改设备。
5. 本地设备添加/修改已隐藏认证方式相关输入。
