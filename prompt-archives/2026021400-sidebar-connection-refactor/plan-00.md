# Sidebar 连接管理重构计划

## 背景

当前前端 sidebar 存在三个关联性 bug：

1. **跨设备窗口切换不跳转**：在设备 A 的窗口中时，点击切换到设备 B 的窗口，只能触发 tmux 的 select window 事件，但页面 URL 没有变化
2. **连接新设备导致旧设备断开**：连接设备 A 后，从 sidebar 连接设备 B，设备 A 会意外断开
3. **导航使用 push 而非 replace**：所有 sidebar 触发的导航都会增加历史记录，应该使用 replace

这些问题的根本原因是**连接管理分散在组件中**（sidebar 和 DevicePage 各自管理），引用计数机制复杂，导致生命周期难以追踪。

## 目标

1. 实现全局统一的设备连接管理
2. 修复跨设备窗口切换不跳转的问题
3. 支持多设备同时保持连接
4. 所有 sidebar 导航使用 replace 而非 push
5. 简化连接状态管理逻辑

## 设计思路

### 新架构：全局连接管理 + 纯导航 Sidebar

```
┌─────────────────────────────────────────────────────────┐
│                     App Level                            │
│  ┌─────────────┐  ┌─────────────────────────────────────┐ │
│  │  AppSidebar │  │        GlobalDeviceManager          │ │
│  │  (纯导航)    │  │  - 维护"应该连接的设备列表"            │ │
│  │             │  │  - 监听路由变化自动连接当前设备          │ │
│  │             │  │  - 持久化到 localStorage              │ │
│  └─────────────┘  └─────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌──────────────┐  ┌────────────────┐  ┌──────────────┐
│  DevicePage  │  │   DevicesPage  │  │ SettingsPage │
│  (只读状态)   │  │  (连接按钮触发)  │               │
└──────────────┘  └────────────────┘  └──────────────┘
```

### 状态流向

1. **用户点击"连接"按钮**（Sidebar）
   - 将设备加入全局 `persistedConnectedDevices` Set
   - 持久化到 localStorage
   - 导航到 `/devices/${deviceId}`（replace）

2. **GlobalDeviceManager 监听路由**
   - 路由变化时，检查 URL 中的 deviceId
   - 如果设备在 `persistedConnectedDevices` 中但未连接，自动连接
   - 如果设备不在列表中但已连接（例如从其他页面直接访问 URL），也进行连接

3. **用户点击"断开"按钮**（Sidebar）
   - 从 `persistedConnectedDevices` 中移除设备
   - 发送断开命令
   - 如果当前正在查看该设备，导航到 `/devices`

4. **用户点击窗口**（Sidebar）
   - 直接导航到对应 URL（replace）
   - DevicePage 自动处理 pane 选择和渲染

### 关键改动

#### 1. 新建 `GlobalDeviceManager` 组件

位置：作为全局组件在 main.tsx 中包裹 RouterProvider

职责：
- 维护 `persistedConnectedDevices: Set<string>` 状态
- 从 localStorage 加载/保存连接列表
- 监听路由变化，自动连接当前设备
- 提供上下文供 sidebar 和 DevicePage 使用

#### 2. 重构 Sidebar

修改点：
- `handleConnectToggle`：
  - 连接：添加到全局列表 + `navigate(`/devices/${deviceId}`, { replace: true })`
  - 断开：从全局列表移除 + 断开命令 + （如果是当前设备）导航到 `/devices`
  
- `handleWindowClick`：
  - 改为：直接 `navigate(..., { replace: true })`
  - 移除 `selectWindow` 调用（DevicePage 会处理）

- 所有导航改为 replace

#### 3. 重构 DevicePage

修改点：
- 移除 `useEffect(() => { connectDevice/disconnectDevice }, [deviceId])`
- 添加 `useEffect`：deviceId 变化时，从 GlobalDeviceManager 确认连接
- 如果已连接，发送 `selectPane` 或 `selectWindow` 命令
- 保留自动选择窗口/pane 的逻辑

#### 4. 简化 tmux store

修改点：
- 移除 `ConnectionRef` 类型和 `connectionRefs` 状态
- `connectDevice(deviceId)`：纯命令发送，不再维护引用计数
- `disconnectDevice(deviceId)`：纯命令发送
- `connectedDevices`：继续保留，反映实际连接状态

## 任务清单

### Phase 1: 基础架构
- [ ] 创建 `GlobalDeviceManager` 组件和 Context
- [ ] 实现 localStorage 持久化
- [ ] 在 main.tsx 中集成 GlobalDeviceManager

### Phase 2: 重构 Sidebar
- [ ] 修改 `handleConnectToggle` 使用全局管理
- [ ] 修改 `handleWindowClick` 直接导航
- [ ] 修改 `navigateToPane` 使用 replace
- [ ] 移除对 tmux store 的直接连接/断开调用

### Phase 3: 重构 DevicePage
- [ ] 移除自动连接/断开的 useEffect
- [ ] 添加确认连接逻辑
- [ ] 确保 deviceId 变化时正确选择 pane/window

### Phase 4: 简化 tmux store
- [ ] 移除 ConnectionRef 类型
- [ ] 移除 connectionRefs 状态
- [ ] 简化 connectDevice/disconnectDevice 实现

### Phase 5: 测试和验证
- [ ] 验证多设备同时连接
- [ ] 验证跨设备窗口切换
- [ ] 验证导航使用 replace
- [ ] 验证页面刷新后连接状态保持

## 验收标准

1. ✅ 可以同时连接多个设备，切换页面不会断开其他设备
2. ✅ 从设备 A 的窗口点击切换到设备 B 的窗口，URL 正确跳转
3. ✅ 所有 sidebar 触发的导航都是 replace，不产生历史记录
4. ✅ 刷新页面后，之前连接的设备自动重新连接
5. ✅ 断开设备后，该设备从 localStorage 中移除
6. ✅ 代码逻辑清晰，不再使用复杂的引用计数

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 重构范围大，可能引入回归 | 高 | 每个 Phase 完成后测试；保留旧版 Sidebar 作为 fallback |
| localStorage 存储异常 | 中 | 使用 try-catch，异常时降级为不持久化 |
| 并发连接过多影响性能 | 低 | 观察后考虑限制最大并发数 |

## 注意事项

1. **保持向后兼容**：DevicePage 和 DevicesPage 的 props 不变
2. **错误处理**：连接失败时，从 persistedConnectedDevices 中移除该设备
3. **清理逻辑**：组件卸载时不需要断开连接（由全局管理）
4. **Edge case**：用户手动输入 URL 访问设备，应该自动连接

## 实现顺序

1. 先实现 GlobalDeviceManager 和 localStorage 持久化
2. 然后修改 Sidebar，使用新的全局管理
3. 同时修改 DevicePage，移除旧的连接逻辑
4. 最后清理 tmux store，移除引用计数
5. 全面测试

---

**开始执行前确认**：
- [ ] 已备份当前代码
- [ ] 测试用例准备就绪
- [ ] 已理解所有改动点
