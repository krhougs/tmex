# 重构执行结果

## 完成内容

### 1. 新建 GlobalDeviceProvider 组件
- **文件**: `src/components/global-device-provider.tsx`
- **功能**:
  - 维护 `persistedDevices` 状态，表示"应该连接的设备列表"
  - 从 localStorage 加载/保存连接列表
  - 监听路由变化，自动连接当前 URL 中的设备
  - 提供 `connectDevice`, `disconnectDevice`, `toggleDevice` 方法

### 2. 重构 Sidebar
- **文件**: `src/components/page-layouts/components/sidebar-device-list.tsx`
- **改动**:
  - 使用 `useGlobalDevice` hook 替代直接调用 tmux store
  - `handleConnectToggle`: 调用全局 toggleDevice，并导航到设备页
  - `handleWindowClick` → `navigateToWindow`: 直接导航到目标窗口（replace）
  - `navigateToPane`: 使用 replace 导航
  - 移除删除设备相关的 AlertDialog 代码

### 3. 重构 DevicePage
- **文件**: `src/pages/DevicePage.tsx`
- **改动**:
  - 移除自动连接/断开的 useEffect（319-329行）
  - 移除 `connectDevice` 和 `disconnectDevice` 的导入
  - 保留其他功能不变

### 4. 简化 tmux store
- **文件**: `src/stores/tmux.ts`
- **改动**:
  - 移除 `ConnectionRef` 类型
  - 移除 `connectionRefs` 和 `lastConnectRequest` 状态
  - `connectDevice(deviceId)` / `disconnectDevice(deviceId)`: 移除 ref 参数，变为纯命令发送

### 5. 更新 main.tsx
- **文件**: `src/main.tsx`
- **改动**:
  - 创建 `RootLayout` 组件包裹 `GlobalDeviceProvider`
  - 使用 Outlet 模式让子路由共享同一个 Provider
  - 移除 PageWrapper 中的 GlobalDeviceProvider

### 6. 修复旧 Sidebar 组件
- **文件**: `src/components/Sidebar.tsx`
- **改动**:
  - 移除所有带 ref 参数的 connectDevice/disconnectDevice 调用
  - 移除 useEffect 中的自动连接逻辑

## 修复的 Bugs

1. ✅ **跨设备窗口切换不跳转**: Sidebar 现在点击窗口直接导航到目标 URL（replace）
2. ✅ **连接新设备导致旧设备断开**: 全局管理维护连接列表，不再在 DevicePage 卸载时断开
3. ✅ **导航使用 push 而非 replace**: 所有 Sidebar 触发的导航都使用 `navigate(to, { replace: true })`

## 架构改进

### 连接管理职责分离

**之前**:
- Sidebar 和 DevicePage 各自维护连接引用
- DevicePage 卸载时自动断开设备
- 引用计数机制复杂难懂

**之后**:
- GlobalDeviceProvider 统一管理"应该连接的设备列表"
- 持久化到 localStorage，刷新后自动恢复
- 路由变化时自动连接当前设备
- Sidebar 只修改列表和导航
- DevicePage 只负责展示

### 导航行为

**之前**:
- 连接设备: push 导航
- 点击窗口: 只发送 selectWindow，依赖事件触发导航

**之后**:
- 连接设备: replace 导航到设备页
- 点击窗口: replace 导航到具体 pane URL

## 测试验证

- [x] TypeScript 编译通过
- [x] 生产构建成功

## 注意事项

1. **localStorage 持久化**: 连接的设备列表会保存到 localStorage，刷新后自动恢复
2. **错误处理**: 连接失败时，设备会从 persistedDevices 中移除
3. **向后兼容**: 旧版 Sidebar 组件（Sidebar.tsx）仍然存在但不再维护

## 后续建议

1. 移除旧的 `src/components/Sidebar.tsx`（如果已不再使用）
2. 添加测试用例验证多设备连接场景
3. 考虑限制最大并发连接数
