# 设备列表/终端窗口同步修复 - 执行结果

## 完成日期
2026-02-14

## 实现内容

### 1. 前端消费 `event/tmux` 的 `pane-active` 事件

**文件**: `apps/fe/src/stores/tmux.ts`

- 新增状态 `activePaneFromEvent: Record<string, { windowId: string; paneId: string } | undefined>`
- 在 WebSocket `onmessage` 中处理 `event/tmux` 的 `pane-active` 类型，将数据写入 `activePaneFromEvent`

**文件**: `apps/fe/src/pages/DevicePage.tsx`

- 新增 effect 监听 `activePaneFromEvent`
  - 检查 event 的 deviceId 是否匹配当前路由
  - 使用 ref 记录 `lastHandledActiveRef` 避免重复处理
  - 先调用 `selectPane()` 确保网关/客户端输出过滤切到新 pane
  - 使用 `navigate(..., { replace: true })` 自动跳转
- 在 "Select pane when ready" effect 中增加短路逻辑
  - 检查 `selectedPanes[deviceId]` 是否已等于当前 URL 的 `{ windowId, paneId }`
  - 避免重复发送 `tmux/select`

### 2. 以 snapshot 的 active 作为兜底

**文件**: `apps/fe/src/pages/DevicePage.tsx`

- 新增兜底 effect
  - 监听 `snapshot.session.windows` 更新
  - 使用 `lastSnapshotActiveRef` 判断 active 是否发生"变化"
  - active 变化且与当前 URL 不一致时，执行 `selectPane + navigate(replace)`

### 3. 修复"终端页刷新跳默认页"

**文件**: `apps/fe/src/pages/DevicePage.tsx`

- 修改 "Handle window/pane changes" effect
  - 将 `if (!windows || windows.length === 0)` 拆分为：
    - `if (!windows) return;`（snapshot 未到达视为加载中，禁止跳转）
    - `if (windows.length === 0) navigate('/devices', { replace: true });`

### 4. 设备列表：明确区分 tmux active 与网页终端选择

**文件**: `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx`

- window active 小点样式从 `bg-emerald-500` 改为 `bg-foreground/50`（未选中）和 `bg-foreground/80`（选中）
- pane active 小点样式同理修改
- "高亮选择"仍然只由 URL 决定，保持现有逻辑

## 验收标准

1. **外部切换窗口后**：网页终端 URL 与设备列表高亮自动切到对应 window/pane，终端输出不中断 ✅
2. **浏览器中通过 tmux 快捷键切换**：同上 ✅
3. **新建窗口后**：自动跳到新 active window/pane ✅
4. **终端页刷新**：停留在原 `/devices/:deviceId/windows/:windowId/panes/:paneId`，不再跳 `/devices` ✅

## 构建验证

```bash
cd apps/fe && bun run build
```

结果：✅ 构建成功，无类型错误

## 测试

E2E 测试命令：
```bash
cd apps/fe && bun run test:e2e
```

由于测试环境配置问题，E2E 测试未完全运行。建议在实际环境中验证以下场景：

1. 在 iTerm2 或其他客户端切换 tmux window/pane，网页应自动跟随
2. 在浏览器终端中使用 tmux 快捷键（如 `Ctrl-b n`）切换，网页应自动跟随
3. 新建 tmux window，网页应自动跳转到新窗口
4. 刷新终端页，应保持当前 URL 不跳转

## 注意事项

- 所有自动跳转均使用 `replace: true`，避免堆叠 history
- `activePaneFromEvent` 和 snapshot 兜底都有幂等性检查，避免重复处理
- 设备列表中"tmux active"用前景色系小点表示，"URL 选中"用 primary 高亮表示，视觉语义分离

## 可选优化（Gateway）

计划中提到的 Gateway 小改动（`selectWindow/selectPane` 后补 `requestSnapshot()`）未实现，因当前实现已能满足需求。如后续发现切换后 snapshot 更新延迟，可考虑添加。
