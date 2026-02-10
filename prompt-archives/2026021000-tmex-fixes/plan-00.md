# Tmex 修复计划

## 概述
修复 4 个问题：
1. 本地 tmux 报错 `tcgetattr failed: Inappropriate ioctl for device`
2. 前端连接失败的错误提示用户体验太差
3. 设备管理缺少 session 字段
4. 前端 UI 改进（使用 `@base-ui/react` 和 `shadcn/ui`）

---

## 问题 1：修复本地 tmux tcgetattr 错误

### 问题分析
本地 tmux 启动时没有分配伪终端（PTY），导致 tmux 报错 `tcgetattr failed: Inappropriate ioctl for device`。

### 修复方案
在 `/home/krhougs/tmex/apps/gateway/src/tmux/connection.ts` 第 58 行的 `connectLocal()` 方法中，使用 `node-pty` 替代 `child_process.spawn`，为本地 tmux 分配伪终端。

### 具体修改
**文件**: `/home/krhougs/tmex/apps/gateway/src/tmux/connection.ts`

1. 添加 `node-pty` 依赖（如果尚未安装）
2. 修改 `connectLocal()` 方法：
   - 使用 `pty.spawn` 替代 `spawn`
   - 设置合适的终端类型（`xterm-256color`）
   - 保持相同的参数 `['-CC', 'new-session', '-A', '-s', 'tmex']`

### 验证步骤
1. 启动 gateway 服务
2. 添加一个本地设备
3. 连接设备，检查控制台不再出现 `tcgetattr failed` 错误

---

## 问题 2：改进前端连接错误提示 UX

### 问题分析
当前 SSH 连接失败时显示原始错误信息 `All configured authentication methods failed`，用户难以理解。

### 修复方案
在前后端分别添加错误消息映射，将技术错误转换为用户友好的中文提示。

### 具体修改

**文件 1**: `/home/krhougs/tmex/apps/gateway/src/ws/index.ts` (第 162-174 行)

添加错误分类和友好消息映射函数：
```typescript
// 错误类型分类
function classifyError(error: Error): { type: string; message: string } {
  const msg = error.message.toLowerCase();

  if (msg.includes('all configured authentication methods failed')) {
    return {
      type: 'auth_failed',
      message: '认证失败：用户名、密码或密钥不正确，请检查设备配置'
    };
  }
  if (msg.includes('connect refused') || msg.includes('connection refused')) {
    return {
      type: 'connection_refused',
      message: '连接被拒绝：无法连接到目标主机，请检查主机地址和端口是否正确'
    };
  }
  if (msg.includes('timeout') || msg.includes('etimedout')) {
    return {
      type: 'timeout',
      message: '连接超时：无法连接到设备，请检查网络或防火墙设置'
    };
  }
  if (msg.includes('host not found') || msg.includes('getaddrinfo')) {
    return {
      type: 'host_not_found',
      message: '主机未找到：无法解析主机地址，请检查 DNS 或主机名是否正确'
    };
  }
  if (msg.includes('handshake failed') || msg.includes('unable to verify')) {
    return {
      type: 'handshake_failed',
      message: '握手失败：无法建立安全连接，可能是密钥交换算法不兼容'
    };
  }

  return {
    type: 'unknown',
    message: `连接失败：${error.message}`
  };
}
```

在 `handleDeviceConnect` 的 catch 块中使用此函数，并扩展 payload 包含 `errorType`：
```typescript
const errorInfo = classifyError(err);
ws.send(JSON.stringify({
  type: 'event/device',
  payload: {
    deviceId,
    type: 'error',
    errorType: errorInfo.type,
    message: errorInfo.message,
    rawMessage: err.message // 保留原始消息供调试
  }
}));
```

**文件 2**: `/home/krhougs/tmex/packages/shared/src/index.ts`

更新 `EventDevicePayload` 接口添加 `errorType` 字段：
```typescript
export interface EventDevicePayload {
  deviceId: string;
  type: DeviceEventType;
  errorType?: string; // 新增
  message?: string;
}
```

**文件 3**: `/home/krhougs/tmex/apps/fe/src/pages/DevicePage.tsx` (第 174-179 行)

改进错误显示样式，使用更醒目的错误提示 UI（红色边框、图标等）。

### 验证步骤
1. 配置一个错误的 SSH 设备（错误的密码/密钥）
2. 尝试连接，验证显示中文友好提示
3. 测试各种错误场景（超时、拒绝连接等）

---

## 问题 3：设备管理添加 session 字段

### 问题分析
设备表缺少 session 字段来存储/跟踪 tmux 会话名称。当前所有设备都使用硬编码的 `tmex` 会话名。

### 修复方案
在 Device 模型中添加 `session` 字段，允许用户为每个设备配置不同的 tmux 会话名称。

### 具体修改

**文件 1**: `/home/krhougs/tmex/packages/shared/src/index.ts` (第 8-25 行)

在 `Device` 接口中添加 session 字段：
```typescript
export interface Device {
  id: string;
  name: string;
  type: DeviceType;
  // SSH 相关
  host?: string;
  port?: number;
  username?: string;
  sshConfigRef?: string;
  session?: string; // 新增：tmux 会话名称，默认为 'tmex'
  // 认证
  authMode: AuthMode;
  // ... 其他字段
}
```

**文件 2**: `/home/krhougs/tmex/apps/gateway/src/db/index.ts`

1. 在 `initSchema()` 函数的设备表创建语句中添加 `session` 字段（第 24-40 行）
2. 在 `createDevice()` 函数中处理 session 字段（第 92-121 行）
3. 在 `updateDevice()` 函数中支持更新 session 字段（第 138-186 行）
4. 在 `rowToDevice()` 函数中添加 session 字段映射（第 340-356 行）

**文件 3**: `/home/krhougs/tmex/apps/gateway/src/tmux/connection.ts` (第 58 行和第 167 行)

修改 `connectLocal()` 和 `connectSSH()` 中的会话名称使用：
- 从 `device.session ?? 'tmex'` 获取会话名
- 替换硬编码的 `'tmex'` 字符串

**文件 4**: `/home/krhougs/tmex/apps/gateway/src/api/index.ts`

检查 API 端点是否传递 session 字段，在创建/更新设备请求中处理 session 字段。

**文件 5**: `/home/krhougs/tmex/apps/fe/src/pages/DevicesPage.tsx`

在添加设备表单中添加 session 输入字段（可选，默认为 `tmex`）。

### 验证步骤
1. 创建新设备，设置自定义 session 名称
2. 连接设备，验证使用正确的 tmux 会话
3. 更新设备 session 字段，验证生效

---

## 问题 4：前端 UI 改进（@base-ui/react + shadcn/ui）

### 问题分析
当前前端使用自定义 CSS 类（btn、input、select 等），UI 较为简陋，需要现代化改进。

### 修复方案

由于项目已使用 `@base-ui-components/react`，我们将：
1. 使用 `@base-ui-components/react` 替换自定义表单组件
2. 使用 `@base-ui-components/react` 的 Dialog 组件替换自定义模态框
3. 引入 `lucide-react` 图标库替换内联 SVG
4. 保持 Tailwind CSS v4 作为样式基础

### 具体修改

**步骤 1**: 安装依赖
```bash
cd /home/krhougs/tmex/apps/fe
npm install lucide-react
```

**步骤 2**: 创建 shadcn/ui 风格的组件封装

创建新目录 `/home/krhougs/tmex/apps/fe/src/components/ui/`，包含：
- `Button.tsx` - 使用 base-ui 的 `unstyled` 模式 + Tailwind
- `Input.tsx` - 输入框组件
- `Select.tsx` - 下拉选择组件
- `Dialog.tsx` - 模态框组件（基于 `@base-ui-components/react/dialog`）
- `Card.tsx` - 卡片组件
- `Alert.tsx` - 警告提示组件

**步骤 3**: 更新 `/home/krhougs/tmex/apps/fe/src/pages/DevicesPage.tsx`

替换自定义表单组件为新的 UI 组件：
- 使用 `Dialog` 替换自定义模态框样式
- 使用 `Button` 替换 `className="btn"`
- 使用 `Input` 替换 `className="input"`
- 使用 `Select` 替换 `className="select"`
- 使用 `Card` 替换设备卡片样式
- 使用 `lucide-react` 图标

**步骤 4**: 更新 `/home/krhougs/tmex/apps/fe/src/pages/DevicePage.tsx`

改进错误提示显示：
- 使用 `Alert` 组件显示连接错误
- 添加错误图标和更醒目的样式

**步骤 5**: 更新 `/home/krhougs/tmex/apps/fe/src/components/Sidebar.tsx`

- 使用 `Button` 组件
- 使用 `lucide-react` 图标

**步骤 6**: 清理 `/home/krhougs/tmex/apps/fe/src/index.css`

保留基础样式（CSS 变量、滚动条、xterm 样式），移除 `.btn`、`.input`、`.select` 等将被替换的样式。

### 验证步骤
1. 运行 `npm run build` 确保构建成功
2. 检查所有页面 UI 是否正常
3. 验证暗黑主题样式正确应用

---

## 关键文件清单

### 需要修改的文件

| 文件路径 | 修改内容 |
|---------|---------|
| `/home/krhougs/tmex/apps/gateway/src/tmux/connection.ts` | 使用 node-pty，添加 session 支持 |
| `/home/krhougs/tmex/apps/gateway/src/ws/index.ts` | 错误分类和友好消息 |
| `/home/krhougs/tmex/apps/gateway/src/db/index.ts` | 添加 session 字段支持 |
| `/home/krhougs/tmex/apps/gateway/src/api/index.ts` | 处理 session 字段 |
| `/home/krhougs/tmex/packages/shared/src/index.ts` | 更新 Device 接口和 EventDevicePayload |
| `/home/krhougs/tmex/apps/fe/src/pages/DevicePage.tsx` | 改进错误显示 |
| `/home/krhougs/tmex/apps/fe/src/pages/DevicesPage.tsx` | 添加 session 字段，UI 组件替换 |
| `/home/krhougs/tmex/apps/fe/src/components/Sidebar.tsx` | UI 组件替换 |
| `/home/krhougs/tmex/apps/fe/src/index.css` | 清理过时样式 |

### 需要创建的文件

| 文件路径 | 用途 |
|---------|-----|
| `/home/krhougs/tmex/apps/fe/src/components/ui/Button.tsx` | 按钮组件 |
| `/home/krhougs/tmex/apps/fe/src/components/ui/Input.tsx` | 输入框组件 |
| `/home/krhougs/tmex/apps/fe/src/components/ui/Select.tsx` | 选择框组件 |
| `/home/krhougs/tmex/apps/fe/src/components/ui/Dialog.tsx` | 模态框组件 |
| `/home/krhougs/tmex/apps/fe/src/components/ui/Card.tsx` | 卡片组件 |
| `/home/krhougs/tmex/apps/fe/src/components/ui/Alert.tsx` | 警告组件 |

---

## 实施顺序建议

1. **先修复问题 1**（tmux 错误）- 影响基础功能
2. **然后修复问题 3**（session 字段）- 涉及数据库 schema 变更
3. **接着修复问题 2**（错误提示 UX）- 依赖问题 3 的结构
4. **最后修复问题 4**（UI 改进）- 主要是样式层面

---

## 数据库迁移说明

由于 SQLite 不支持 ALTER TABLE ADD COLUMN 的完整功能，修改 schema 后需要：

**方案 A**（开发环境）：
- 删除现有数据库文件，让系统重新创建

**方案 B**（生产环境）：
- 编写迁移脚本，创建新表 → 复制数据 → 删除旧表 → 重命名新表

本计划采用方案 A，在开发环境中删除数据库重新初始化。

---

## 测试验证清单

- [ ] 本地设备连接不再报错 `tcgetattr failed`
- [ ] SSH 认证失败显示中文提示"认证失败：用户名、密码或密钥不正确"
- [ ] 连接超时显示中文提示"连接超时：无法连接到设备..."
- [ ] 可以创建带自定义 session 名称的设备
- [ ] 设备连接使用正确的 tmux 会话
- [ ] 前端 UI 使用新组件，样式正常
- [ ] 暗黑主题正常显示
- [ ] 构建成功无错误
