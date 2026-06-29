# Plan: Issue #35 - 通知 toast 显示 pane 名称而非索引

## 背景

当前 bell / notification toast 在前端仅展示数字索引（如 "Window 0 . Pane 1"），多 pane 场景下用户无法分辨是哪个终端触发了通知。

**根因**：gateway 侧 `resolvePaneContext()` 已正确解析出 `paneTitle`（OSC title）和 `paneCurrentCommand`（tmux `pane_current_command`），但 WS Borsh 协议的 `BellEventSchema` / `NotificationEventSchema` 缺少这两个字段，序列化时数据被丢弃。推送通知走 JSON（`PushSupervisor`），不受此问题影响。

**附带问题**：前端 bell/notification toast 的文案全部硬编码为英文，未接入 i18n 系统。

## 项目 owner 明确要求

- 修复通知 toast 显示内容，从纯索引改为有意义的 pane 标识。
- 做好 i18n。

## 设计思路

### 数据流总览

```
tmux-client (pane_title, pane_current_command)
  -> gateway resolvePaneContext() 解析到 PaneLocationContext
    -> 路径 A (JSON push): PushSupervisor 直接传 paneTitle/paneCurrentCommand -- 已正常
    -> 路径 B (WS Borsh): encodeTmuxEventPayload() 序列化 BellEventSchema/NotificationEventSchema
       -- 缺字段，数据丢失 <-- 本次修复点
         -> 前端 decodeTmuxEventPayload() 解码 -- 拿不到 paneTitle/paneCurrentCommand
           -> tmux.ts handleTmuxEvent() 展示 toast -- 只能用 windowIndex/paneIndex
```

### 修复策略

分三层推进：

1. **协议层**（packages/shared/src/ws-borsh/）：在 `BellEventSchema` 和 `NotificationEventSchema` 追加 `paneTitle` 和 `paneCurrentCommand` 两个 `option(string)` 字段，同步更新编解码逻辑。
2. **前端展示层**（apps/fe/src/stores/）：重构 toast 格式化逻辑，优先使用 `paneTitle` / `paneCurrentCommand` 构建有意义的 pane 标识，fallback 到索引。
3. **i18n**（packages/shared/src/i18n/locales/）：新增/修正 i18n key，将前端硬编码英文替换为 i18n 调用。

### Borsh 兼容性说明

`BellEventSchema` / `NotificationEventSchema` 是 `TmuxEventSchema.eventData` 的子 schema，以 `bytes()` 传输后独立反序列化。追加 `option(string)` 字段后，旧版客户端无法解码新版事件数据（Borsh 不支持未知尾部字段）。

**不构成实际风险**：tmex 的 gateway 和前端同包部署、同版本升级，不存在跨版本通信场景。协议文档需同步更新以反映变更。

## 详细任务清单

### 任务 1：扩展 Borsh Schema

**文件**：`packages/shared/src/ws-borsh/schema.ts`

**改动**：

- `BellEventSchema`（当前字段：windowId, paneId, windowIndex, paneIndex, paneUrl）：
  - 末尾追加 `paneTitle: OptionStringSchema`
  - 末尾追加 `paneCurrentCommand: OptionStringSchema`

- `NotificationEventSchema`（当前字段：source, title, body, windowId, paneId, windowIndex, paneIndex, paneUrl）：
  - 末尾追加 `paneTitle: OptionStringSchema`
  - 末尾追加 `paneCurrentCommand: OptionStringSchema`

**验证**：TypeScript 编译通过，下游 convert.ts 类型推导无报错。

### 任务 2：更新编解码转换层

**文件**：`packages/shared/src/ws-borsh/convert.ts`

**改动**：

- `encodeEventData()` 的 `'bell'` 分支：
  - 在类型断言中增加 `paneTitle?: string` 和 `paneCurrentCommand?: string`
  - 在 `serialize()` 调用中增加 `paneTitle: d.paneTitle ?? null` 和 `paneCurrentCommand: d.paneCurrentCommand ?? null`

- `encodeEventData()` 的 `'notification'` 分支：同上处理。

- `decodeEventData()` 的 `'bell'` 分支：
  - 在返回对象中增加 `paneTitle: bell.paneTitle ?? undefined` 和 `paneCurrentCommand: bell.paneCurrentCommand ?? undefined`

- `decodeEventData()` 的 `'notification'` 分支：
  - 在返回对象中增加 `paneTitle: notification.paneTitle ?? undefined` 和 `paneCurrentCommand: notification.paneCurrentCommand ?? undefined`

**验证**：类型检查通过，编解码 roundtrip 测试通过。

### 任务 3：更新编解码单元测试

**文件**：`packages/shared/src/ws-borsh/convert.test.ts`

**改动**：

- 修改 `'应该正确编解码 bell 事件'` 测试：
  - 在 payload.data 中增加 `paneTitle: 'vim session'` 和 `paneCurrentCommand: 'vim'`
  - 更新 expect 断言匹配新字段

- 修改 `'应该正确编解码 notification 事件'` 测试：
  - 在 payload.data 中增加 `paneTitle: 'build monitor'` 和 `paneCurrentCommand: 'make'`
  - 更新 expect 断言匹配新字段

- 新增测试 `'bell 事件无 paneTitle/paneCurrentCommand 时解码为 undefined'`：
  - 验证只传旧字段（不传 paneTitle/paneCurrentCommand）时，编解码后 paneTitle 和 paneCurrentCommand 为 undefined

- 新增测试 `'notification 事件无 paneTitle/paneCurrentCommand 时解码为 undefined'`：同上。

**验证**：`bun test packages/shared/src/ws-borsh/convert.test.ts` 全绿。

### 任务 4：重构前端 bell toast 显示

**文件**：`apps/fe/src/stores/tmux.ts`

**改动**：

- 在文件顶部导入 i18n：`import i18n from '../i18n';`

- 重构 `handleTmuxEvent()` 中 `payload.type === 'bell'` 分支：
  - 将硬编码的 `'Terminal Bell'` 替换为 `i18n.t('terminal.bellNotification')`
  - 将 description 构建逻辑从内联硬编码改为调用新的格式化函数（见任务 5），该函数构建带 paneTitle/paneCurrentCommand 的标识
  - 将 fallback `'Received tmux bell'` 替换为 `i18n.t('terminal.bellFallback')`

**验证**：bell toast 在有 paneTitle 时显示 title，有 paneCurrentCommand 时显示进程名，无两者时 fallback 到索引。

### 任务 5：重构前端 notification toast 格式化

**文件**：`apps/fe/src/stores/tmux-notification-format.ts`

**改动**：

- 导入 i18n：`import i18n from '../i18n';`

- 重构 `buildPaneLocationLabel()`，构建优先级如下：
  1. 若 `paneTitle` 存在 -> 使用 pane title 作为 pane 标识（如 "vim session"）
  2. 若 `paneCurrentCommand` 存在 -> 使用进程名作为 pane 标识（如 "vim"）
  3. 否则 fallback 到 `Pane ${paneIndex}`（保持现有行为）
  - window 标识：保持 `Window ${windowIndex}`（window name 不在事件数据中）
  - 用 i18n key 替代硬编码的 "Window" / "Pane" 前缀

- 重构 `formatTerminalNotificationToast()`：
  - 将 fallback title `'Terminal Notification'` 替换为 i18n key
  - 将 fallback detail 中的 `'From'` 和 `'Terminal notification'` 替换为 i18n key

**验证**：notification toast 在有 paneTitle 时显示有意义标识。

### 任务 6：更新前端通知格式测试

**文件**：`apps/fe/src/stores/tmux-notification-format.test.ts`

**改动**：

- 更新现有测试以匹配新的格式化逻辑（注意 i18n 在测试环境中的处理，可能需要 mock 或使用 fallback key）

- 新增测试用例：
  - `'uses paneTitle when available'`：传入 `paneTitle: 'build monitor'`，验证 description 包含 "build monitor"
  - `'uses paneCurrentCommand as fallback when paneTitle is absent'`：传入 `paneCurrentCommand: 'vim'`，验证 description 包含 "vim"
  - `'falls back to pane index when no title or command'`：只传 `paneIndex: 3`，验证 fallback 到索引
  - `'handles bell data with paneTitle'`：验证 bell toast 包含 pane title

**验证**：`bun test apps/fe/src/stores/tmux-notification-format.test.ts` 全绿。

### 任务 7：更新 i18n 翻译文件

**文件**：
- `packages/shared/src/i18n/locales/en_US.json`
- `packages/shared/src/i18n/locales/zh_CN.json`
- `packages/shared/src/i18n/locales/ja_JP.json`

**改动**（在 `terminal` 命名空间下新增/修改 key）：

新增 key：
- `terminal.bellDescriptionWithTitle`：带 pane 标识的 bell 描述模板
  - en: `"Window {{window}} · {{paneLabel}}"`
  - zh: `"窗口 {{window}} · {{paneLabel}}"`
  - ja: `"ウィンドウ {{window}} · {{paneLabel}}"`
- `terminal.notificationFallbackTitle`：通知的 fallback 标题
  - en: `"Terminal Notification"`
  - zh: `"终端通知"`
  - ja: `"ターミナル通知"`
- `terminal.notificationFallbackDetail`：通知的 fallback 详情
  - en: `"Terminal notification"`
  - zh: `"终端通知"`
  - ja: `"ターミナル通知"`
- `terminal.notificationSourceLabel`：来源标签
  - en: `"From {{source}}"`
  - zh: `"来自 {{source}}"`
  - ja: `"{{source}} から"`
- `terminal.paneProcess`：进程名标签
  - en: `"{{command}}"`
  - zh: `"{{command}}"`
  - ja: `"{{command}}"`

注意：具体 key 命名和模板变量可在实现时根据实际格式化需求微调。核心原则是所有用户可见文本都走 i18n。

**验证**：三份 locale 文件结构一致、key 齐全。

### 任务 8：运行 i18n 生成脚本

**命令**：`bun run build:i18n`

此脚本会从 locale JSON 生成 `packages/shared/src/i18n/resources.ts` 和 `packages/shared/src/i18n/types.ts`。

**验证**：生成文件内容已更新，TypeScript 编译通过。

### 任务 9：更新 WS 协议文档

**文件**：`docs/ws-protocol/2026021402-ws-borsh-v1-spec.md`

**改动**：

- 在 bell 子 schema 文档中追加：
  - `paneTitle: option(string)`
  - `paneCurrentCommand: option(string)`

- 在 notification 子 schema 文档中追加：
  - `paneTitle: option(string)`
  - `paneCurrentCommand: option(string)`

**验证**：文档与代码一致。

### 任务 10：更新 WS server 测试

**文件**：`apps/gateway/src/ws/index.test.ts`

**改动**：

- 更新 `'extends notification event with pane context from snapshot'` 测试：
  - 验证 `extendTmuxEvent` 返回的 data 包含 `paneTitle` 和 `paneCurrentCommand`（从 snapshot 的 pane 数据解析而来）
  - 当前 snapshot 测试数据中的 pane 没有 `title` 和 `currentCommand`，需补充

**验证**：`bun test apps/gateway/src/ws/index.test.ts` 全绿。

### 任务 11：全量测试验证

**命令**：
- `bun test packages/shared/src/ws-borsh/`（协议编解码）
- `bun test apps/fe/src/stores/`（前端 store/格式化）
- `bun test apps/gateway/src/tmux/`（bell-context）
- `bun test apps/gateway/src/ws/`（WS server）
- 全量 `bun test`

**验证**：全部测试通过，无回归。

## 测试策略

| 层级 | 范围 | 方法 |
|------|------|------|
| 协议层 | bell/notification 编解码 roundtrip | 单元测试（convert.test.ts） |
| 协议层 | 新字段缺失时的 fallback | 单元测试（convert.test.ts） |
| gateway | resolvePaneContext 含 paneTitle/paneCurrentCommand | 现有测试已覆盖（bell-context.test.ts） |
| gateway | extendTmuxEvent 透传新字段 | 单元测试（ws/index.test.ts） |
| 前端 | notification toast 格式化 | 单元测试（tmux-notification-format.test.ts） |
| 前端 | bell toast 格式化 | 单元测试（tmux-notification-format.test.ts 或内联验证） |
| i18n | 三语 locale key 齐全 | build:i18n 编译无报错 + TS 类型检查 |

## 验收标准

1. bell toast 在有 paneTitle 时显示 title（如 "Window 0 . vim session"），无 title 时优先显示 paneCurrentCommand（如 "Window 0 . vim"），两者都无时 fallback 到 "Window 0 . Pane 1"。
2. notification toast 同上逻辑展示 pane 标识。
3. 所有用户可见的 toast 文本均通过 i18n 系统输出，en/zh/ja 三语齐全。
4. 推送通知（JSON 路径）行为不受影响。
5. 全量测试通过，无回归。
6. WS 协议文档与代码同步。

## 风险和注意事项

1. **Borsh schema 变更是破坏性的**：追加字段后旧版前端无法解码新版事件。由于 gateway 和前端同包同版本部署，不构成实际风险，但升级时必须 gateway 和前端一起更新。
2. **i18n 生成文件禁止手动修改**：`resources.ts` 和 `types.ts` 由 `bun run build:i18n` 生成，只修改 locale JSON 文件，然后跑生成脚本。不要对生成文件做 lint/format。
3. **前端 i18n 在 store 中使用 `i18n.t()` 而非 React hook**：store 文件（非 React 组件）使用直接导入的 `i18n` 实例调用 `t()`，参考 `apps/fe/src/stores/agent.ts` 中的模式。
4. **paneTitle 和 paneCurrentCommand 可能为空**：当 tmux 未设置 OSC title 或快照未就绪时，这两个字段可能为 undefined，格式化逻辑必须有 fallback。
5. **不涉及 PaneWireSchema 变更**：`PaneWireSchema`（state snapshot 中的 pane 数据）当前也缺少 `currentCommand` 字段，但这是独立问题，不在本次修复范围。state snapshot 的 `currentCommand` 丢失不影响本次修复，因为 bell/notification 事件中直接携带了 `paneCurrentCommand`。
6. **测试环境中 i18n 的处理**：前端单元测试中 `i18n.t()` 可能返回 key 本身（未初始化），需确认测试中是否需要 mock i18n 或使用 key 作为 expected value。参考现有测试模式。
