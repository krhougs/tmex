# Issue #40：OSC 52 剪贴板支持

## 背景

tmex 的网页终端使用 Ghostty WASM（非 xterm.js）作为终端引擎。当 TUI 程序（Claude Code、vim、neovim 等）通过 OSC 52 转义序列（`ESC ] 52 ; c ; <base64> BEL`）请求写入系统剪贴板时，该序列在 gateway 侧的 `pane-stream-parser.ts` 被静默丢弃，导致复制无法写入用户的系统剪贴板。

### 数据流路径

```
tmux control mode
  -> control-mode-parser（分离 pane 数据流）
    -> pane-stream-parser（逐字节拦截 OSC 序列）
      -> WebSocket (Borsh 协议, KIND_TERM_OUTPUT)
        -> 前端 terminal.write()（Ghostty WASM 渲染）
```

### 当前 OSC 处理状态

`pane-stream-parser.ts` 的 `osc-params` 阶段，仅对以下 oscKind 进入 `osc-body`（正常收集 payload）：

- `0/1/2`：标题
- `9/99/777/1337`：桌面通知
- `133`：prompt marker（shell 集成）

**OSC 52** 进入 `osc-body-ignore` 分支，原始字节既不转发给前端也不提取内容。即使 OSC 52 字节到达前端，Ghostty WASM 也没有剪贴板回调通道将 OSC 52 数据传回 JavaScript 层。

### 现有剪贴板实现

仅支持用户鼠标/触控选中复制（`selection-clipboard.ts` 提供 `writeTextToClipboard()` ），没有任何 OSC handler。

## 项目 Owner 的明确要求

1. 只有当发送 OSC 52 的窗口为前端当前窗口时，才尝试写入剪贴板。
2. 只有网页处于前台时，才尝试写入剪贴板。
3. OSC 52 读取（`?` query）应默认禁用或不实现（远端读取本机剪贴板是安全风险）。

## 设计思路

### 方案选型：gateway 拦截 vs. 前端透传

**选定方案：gateway 拦截 + 独立协议消息**

理由：

1. **Ghostty WASM 不支持回调**：即使将 OSC 52 透传到前端，Ghostty WASM 的导入只注册了 `log` 函数，没有剪贴板回调通道，无法将解析出的 OSC 52 数据传回 JavaScript 层。
2. **与现有 OSC 处理模式一致**：bell、notification、prompt marker 均在 gateway 侧 `pane-stream-parser` 拦截后通过专用回调向上传递，OSC 52 遵循同样的模式。
3. **可控性好**：在 gateway 侧解析并验证 base64 payload，防止恶意超大数据通过协议层传输。

### 分层设计

#### 第一层：Gateway `pane-stream-parser.ts`

- 将 `'52'` 加入 `osc-params` 阶段的已处理 `oscKind` 列表。
- 在 `emitOsc()` 中解析 OSC 52 payload 格式：`<selection>;<base64-data>`。
- 通过新增回调 `onClipboardWrite?: (data: string) => void` 将解码后的纯文本向上传递。
- 仅处理写入操作（即 base64 data 不为 `?`），读取请求静默丢弃。
- 对 base64 payload 设置大小上限（复用现有 `MAX_OSC_PAYLOAD_BYTES = 8KB`，解码后约 6KB 文本，覆盖绝大多数正常复制场景）。

#### 第二层：`control-mode-subscription.ts` / `connection-types.ts`

- `ControlModeSubscriptionCallbacks` 新增 `onClipboardWrite?: (paneId: string, text: string) => void`。
- 从 `pane-stream-parser` 的新回调桥接到 subscription 的回调。

#### 第三层：`local-external-connection.ts` + `device-session-runtime.ts`

- `TmuxConnectionOptions` 新增 `onClipboardWrite?: (paneId: string, text: string) => void`。
- `DeviceSessionRuntimeListener` 新增 `onClipboardWrite?: (paneId: string, text: string) => void`。
- 沿现有的 broadcast 模式逐层传递。

#### 第四层：WS 协议层（`ws-borsh`）

- 在 `kind.ts` 中新增 `KIND_CLIPBOARD_WRITE = 0x0307`（终端数据 0x0300-0x03FF 段）。
- 在 `schema.ts` 中新增 `ClipboardWriteSchema`：

  ```ts
  export const ClipboardWriteSchema = b.struct({
    deviceId: b.string(),
    paneId: b.string(),
    text: b.string(),
  });
  ```

- 在 `kind.ts` 的 `VALID_KINDS` 集合和 `kindToString` 映射中注册新 kind。
- 在 `ws-borsh/index.ts` 中导出新常量和 schema。

#### 第五层：Gateway WS Server（`ws/index.ts` + `ws/borsh/codec-borsh.ts`）

- 在 `codec-borsh.ts` 中新增 `encodeClipboardWrite()` 编码函数。
- 在 `WebSocketServer` 的 `attachRuntime()` 中监听 `onClipboardWrite` 回调。
- 新增 `broadcastClipboardWrite(deviceId, paneId, text)` 方法：
  - 遍历该 device 的所有 client。
  - **仅发送给 `client.data.borshState.selectedPanes[deviceId] === paneId` 的 client**（实现「只有当前窗口」的约束）。
  - 编码为 `KIND_CLIPBOARD_WRITE` 消息并发送。

#### 第六层：前端 WS 消息处理（`stores/tmux.ts`）

- 在 `handleBorshMessage` 的 `switch` 中新增 `KIND_CLIPBOARD_WRITE` 分支：
  - 解码 `ClipboardWriteSchema`。
  - 调用新的 clipboard write handler。

#### 第七层：前端剪贴板写入

- 在前端新增 clipboard write handler（可以放在 `stores/tmux.ts` 中内联，或提取到独立模块）：
  - **前台检查**：`document.visibilityState === 'visible'`，后台时静默丢弃（满足 owner 要求）。
  - **当前 pane 检查**：比较消息中的 `deviceId + paneId` 与当前 selectedPanes 中的记录，不匹配则丢弃（满足 owner 要求）。
  - 调用 `navigator.clipboard.writeText(text)`。
  - 写入成功时静默（不弹 toast 打扰用户正常工作流）。
  - 写入失败时 `console.warn` 记录（HTTP 环境或后台标签页可能失败），不弹 toast（TUI 程序自身会有 fallback 提示）。

### 关于 tmux passthrough（DCS 包裹）

`pane-stream-parser.ts` 已支持 tmux passthrough 解包（`dcs-tmux` 系列状态）：外层 DCS `ESC P tmux; ... ESC \` 中的内容会被 `flushTmuxPassthrough()` 递归 feed 回 `processByte()`。因此 tmux passthrough 包裹的 OSC 52（如 `ESC P tmux; ESC ESC ] 52;c;... ESC ESC \ ESC \`）会被自动解包后走正常 OSC 52 处理路径，**无需额外代码**。

### 关于 SSH 连接

`ssh-external-connection.ts` 与 `local-external-connection.ts` 共享相同的 `TmuxConnectionOptions` 和 `ControlModeSubscription`。新增的 `onClipboardWrite` 回调会自动覆盖 SSH 场景，**无需额外代码**。

## 详细任务清单

### 任务 1：`pane-stream-parser.ts` —— 拦截并解析 OSC 52

**涉及文件**：`apps/gateway/src/tmux-client/pane-stream-parser.ts`

1. 在 `PaneStreamParserOptions` 接口中新增可选回调：
   ```ts
   onClipboardWrite?: (text: string) => void;
   ```

2. 在 `osc-params` 阶段的 oscKind 白名单中加入 `'52'`（第 317-326 行的条件表达式）。

3. 在 `emitOsc()` 函数的 `switch` 中新增 `case '52'`：
   - 解析 payload 格式：`<selection>;<base64-data>`（以第一个 `;` 分割）。
   - 如果 base64-data 为 `?`（读取请求），静默丢弃（`return`）。
   - 用 `atob()` / `Uint8Array` + `TextDecoder` 解码 base64 数据为纯文本。
   - 解码失败时（非法 base64）静默丢弃。
   - 调用 `options.onClipboardWrite?.(decodedText)`。

**验证点**：
- OSC 52 写入请求被正确拦截并解码。
- OSC 52 读取请求（`?`）被静默丢弃。
- 非法 base64 不会导致异常。
- tmux passthrough 包裹的 OSC 52 也能正确处理（现有机制自动支持）。
- OSC 52 的原始字节不会泄漏到输出流中。
- 现有 OSC 处理（标题/通知/prompt marker）不受影响。

### 任务 2：`pane-stream-parser.test.ts` —— 单元测试

**涉及文件**：`apps/gateway/src/tmux-client/pane-stream-parser.test.ts`

新增测试 describe 块 `pane stream parser - OSC 52 clipboard`：

1. **基本写入**：发送 `ESC ] 52 ; c ; <base64("hello")> BEL`，验证 `onClipboardWrite` 回调被调用且 text 为 `"hello"`，且输出流不含 OSC 52 字节。
2. **ST 终结**：发送 `ESC ] 52 ; c ; <base64> ESC \`，验证同上。
3. **读取请求丢弃**：发送 `ESC ] 52 ; c ; ? BEL`，验证 `onClipboardWrite` 不被调用。
4. **非法 base64 丢弃**：发送 `ESC ] 52 ; c ; %%%invalid BEL`，验证 `onClipboardWrite` 不被调用且不抛异常。
5. **空 payload 处理**：发送 `ESC ] 52 ; c ; BEL`（空 base64），验证 `onClipboardWrite` 不被调用（空字符串没有意义）或被调用时 text 为空字符串。
6. **多种 selection 参数**：发送 `ESC ] 52 ; s ; <base64> BEL`（primary selection）和 `ESC ] 52 ; pc ; <base64> BEL`（多 selection），验证均能正确解码。
7. **tmux passthrough 包裹**：发送 DCS 包裹的 OSC 52，验证能正确解码（复用现有 passthrough 测试模式）。
8. **跨 push 调用**：将 OSC 52 序列分成多个 `push()` 调用，验证 parser 状态跨调用正确维持。
9. **payload 大小上限**：发送超过 `MAX_OSC_PAYLOAD_BYTES` 的 OSC 52 payload，验证被 truncate/丢弃而非 OOM。
10. **与其他 OSC 交错**：在 OSC 52 前后穿插 OSC 2（标题）和普通输出字节，验证互不影响。

### 任务 3：回调链路传递

**涉及文件**：

- `apps/gateway/src/tmux-client/connection-types.ts`
- `apps/gateway/src/tmux-client/control-mode-subscription.ts`
- `apps/gateway/src/tmux-client/local-external-connection.ts`
- `apps/gateway/src/tmux-client/ssh-external-connection.ts`（如果也有类似的 subscription 接线）
- `apps/gateway/src/tmux-client/device-session-runtime.ts`

1. **`connection-types.ts`**：在 `TmuxConnectionOptions` 中新增：
   ```ts
   onClipboardWrite?: (paneId: string, text: string) => void;
   ```

2. **`control-mode-subscription.ts`**：
   - `ControlModeSubscriptionCallbacks` 新增 `onClipboardWrite?: (paneId: string, text: string) => void`。
   - 在 `getPaneParser()` 创建 `createPaneStreamParser()` 时传入 `onClipboardWrite` 回调，桥接到 `callbacks.onClipboardWrite?.(paneId, text)`。

3. **`local-external-connection.ts`**：
   - 在 `spawnControlClientProcess()` 中 `createControlModeSubscription()` 的回调对象中新增 `onClipboardWrite`，调用 `this.callbacks.onClipboardWrite?.(paneId, text)`。

4. **`ssh-external-connection.ts`**：同样在其 `createControlModeSubscription()` 调用处新增 `onClipboardWrite` 回调。需先检查该文件是否有类似结构（大概率有，因为 SSH 和 local 共用同一套 control-mode-subscription）。

5. **`device-session-runtime.ts`**：
   - `DeviceSessionRuntimeListener` 新增 `onClipboardWrite?: (paneId: string, text: string) => void`。
   - 在 constructor 的 `createConnection()` 回调中新增 `onClipboardWrite`，broadcast 给所有 listeners。

**验证点**：
- 从 pane-stream-parser 到 device-session-runtime 的回调链完整贯通。
- 所有可选回调均以 `?.` 调用，不破坏现有未传入该回调的代码路径。

### 任务 4：WS Borsh 协议扩展

**涉及文件**：

- `packages/shared/src/ws-borsh/kind.ts`
- `packages/shared/src/ws-borsh/schema.ts`
- `packages/shared/src/ws-borsh/index.ts`

1. **`kind.ts`**：
   - 新增 `export const KIND_CLIPBOARD_WRITE = 0x0307;`（终端数据区段 0x0300-0x03FF）。
   - 在 `VALID_KINDS` 集合中添加 `KIND_CLIPBOARD_WRITE`。
   - 在 `kindToString` 映射中添加 `[KIND_CLIPBOARD_WRITE]: 'CLIPBOARD_WRITE'`。

2. **`schema.ts`**：
   - 新增：
     ```ts
     export const ClipboardWriteSchema = b.struct({
       deviceId: b.string(),
       paneId: b.string(),
       text: b.string(),
     });
     ```

3. **`index.ts`**：
   - 在 Kind 常量导出中添加 `KIND_CLIPBOARD_WRITE`。
   - schema 已通过 `export * as schema from './schema'` 自动导出，无需额外操作。

**验证点**：
- `isValidKind(0x0307)` 返回 `true`。
- `kindToString(0x0307)` 返回 `'CLIPBOARD_WRITE'`。
- `ClipboardWriteSchema` 能正确 serialize/deserialize。

### 任务 5：Gateway WS Server 发送

**涉及文件**：

- `apps/gateway/src/ws/borsh/codec-borsh.ts`
- `apps/gateway/src/ws/index.ts`

1. **`codec-borsh.ts`**：新增编码函数：
   ```ts
   export function encodeClipboardWrite(
     params: b.infer<typeof wsBorsh.schema.ClipboardWriteSchema>,
     seq: number
   ): Uint8Array {
     const payload = wsBorsh.encodePayload(wsBorsh.schema.ClipboardWriteSchema, params);
     return wsBorsh.encodeEnvelope(wsBorsh.KIND_CLIPBOARD_WRITE, payload, seq);
   }
   ```

2. **`ws/index.ts`**：
   - 在 `attachRuntime()` 的 listener 中新增 `onClipboardWrite` 处理。
   - 新增 `broadcastClipboardWrite(deviceId: string, paneId: string, text: string)` 方法：
     - 获取 `DeviceConnectionEntry`。
     - 遍历 entry.clients，**仅发送给 `selectedPanes[deviceId] === paneId` 的 client**。
     - 用 `encodeClipboardWrite` 编码并通过 `sendEnvelope` 发送。

**验证点**：
- 只有当前选中该 pane 的 client 会收到 clipboard write 消息。
- 其他 client（选中不同 pane 或不同 device）不会收到。

### 任务 6：前端接收并写入剪贴板

**涉及文件**：

- `apps/fe/src/stores/tmux.ts`

1. 在 `handleBorshMessage` 的 `switch` 中新增 `case wsBorsh.KIND_CLIPBOARD_WRITE` 分支：
   - 解码 `ClipboardWriteSchema`。
   - 调用 clipboard write handler。

2. clipboard write handler 逻辑：
   - **前台检查**：`document.visibilityState !== 'visible'` 时丢弃。
   - **当前 pane 检查**：比较 `deviceId + paneId` 与 `getState().selectedPanes[deviceId]?.paneId`，不匹配则丢弃。
   - 调用 `navigator.clipboard.writeText(decoded.text)`。
   - `.catch()` 中 `console.warn` 记录失败（不弹 toast）。

**验证点**：
- 后台标签页不触发剪贴板写入。
- 非当前 pane 的 OSC 52 不触发剪贴板写入。
- HTTPS 环境下正常写入。
- HTTP 环境下优雅失败（console.warn，不崩溃）。

### 任务 7：`PaneStreamNotification` 类型兼容性检查

**涉及文件**：无需修改，仅验证

OSC 52 **不走** notification 路径（`PaneStreamNotification` / `onNotification`），而是走独立的 `onClipboardWrite` 回调，因此现有的 notification 类型、throttle 逻辑、push 通知等不受影响。此任务只做代码审查确认。

## 测试策略

### 单元测试

- **`pane-stream-parser.test.ts`**：任务 2 详述的 10+ 个用例。
- **`ws-borsh` 序列化/反序列化**：新增 `ClipboardWriteSchema` 的 round-trip 测试（如果现有 convert.test.ts 中有类似模式就跟随）。

### 集成验证

- 启动 dev 服务器（`bun run dev`），在网页终端中运行：
  ```bash
  printf '\e]52;c;aGVsbG8=\a'
  ```
  （`aGVsbG8=` 是 `"hello"` 的 base64 编码）

  验证系统剪贴板中出现 `"hello"`。

- 在网页终端中运行 `vim`，在 vim 中执行 `"+yy`（yank to system clipboard），验证剪贴板内容正确。

- 将浏览器标签切到后台，重复上述 `printf` 命令，验证剪贴板内容**不变**。

- 切换到另一个 pane 后，在原 pane 中执行 `printf` 命令（需通过其他方式触发，如 tmux send-keys），验证剪贴板内容**不变**。

### 跨平台验证

- Chrome / Safari / Firefox 在 HTTPS 下的 `navigator.clipboard.writeText()` 行为。
- HTTP 下的优雅降级（`console.warn`，不崩溃）。
- iOS Safari 的 clipboard API 可用性。

## 验收标准

1. 在 tmex 网页终端内运行 `printf '\e]52;c;aGVsbG8=\a'`，`"hello"` 出现在系统剪贴板中。
2. 在 tmex 网页终端内运行 Claude Code，触发复制操作，内容写入系统剪贴板（不再提示 `prefix + ]`）。
3. 在 tmex 网页终端内运行 vim/neovim，`"+y` 操作写入系统剪贴板。
4. 切换到另一个 pane 或将标签页切至后台时，OSC 52 不会写入剪贴板。
5. OSC 52 读取请求（`?`）被静默丢弃，不触发任何操作。
6. 所有现有测试通过，无回归。
7. `pane-stream-parser.test.ts` 中新增的 OSC 52 测试全部通过。

## 风险和注意事项

### 1. `navigator.clipboard.writeText()` 的浏览器限制

- **安全上下文**：需要 HTTPS 或 localhost。HTTP 部署将无法使用此功能。
- **用户激活**：部分浏览器要求最近有用户交互。终端窗口通常已有交互（键盘输入），但如果用户长时间不操作后 TUI 程序后台触发复制，可能失败。
- **后台标签页**：`document.visibilityState !== 'visible'` 时主动丢弃，避免浏览器拒绝 API 调用后报错。

### 2. base64 解码

- Gateway 侧（Bun 运行时）使用全局 `atob()` 解码 base64。
- 需注意 OSC 52 的 base64 编码的是原始字节，不一定是 UTF-8。标准实践中 TUI 程序发送的通常是 UTF-8 文本。使用 `TextDecoder` 解码时设置 `fatal: false` 以优雅处理非法 UTF-8。

### 3. payload 大小

- 复用现有 `MAX_OSC_PAYLOAD_BYTES = 8KB` 限制。这对应约 6KB 解码文本，覆盖绝大多数正常复制场景。
- 超大复制（如整个文件内容）会被 truncate。这是合理的安全限制。
- 注意：如果未来需要支持更大的复制内容，可以单独为 OSC 52 设置更大的上限，但当前 8KB 是安全的起点。

### 4. 不实现 OSC 52 读取

- 远端程序通过 OSC 52 读取本机剪贴板是安全风险。
- 本次实现**仅处理写入**，读取请求（base64 部分为 `?`）被静默丢弃。
- 如果未来需要支持读取，需要：(1) 用户设置开关（2) 反向消息通道（C2S 方向）(3) 安全审计。

### 5. 协议版本兼容

- 新增的 `KIND_CLIPBOARD_WRITE` 不影响旧客户端。旧客户端不认识该 kind 会忽略（前端 switch 中的 default 分支不处理未知 kind）。
- 新客户端连接旧 gateway 不会收到该消息，行为与当前一致（OSC 52 被丢弃）。

### 6. 注意事项

- **不要修改 `PaneStreamNotification` 类型**：OSC 52 走独立的 `onClipboardWrite` 通道，不要混入 notification 系统。
- **所有新增回调均为可选**（`?.` 调用），不破坏现有未传入该回调的代码路径（如测试用例中的 mock）。
- **SSH 连接场景**：确认 `ssh-external-connection.ts` 的 subscription 接线方式，如果结构与 local 一致则同样新增 `onClipboardWrite`。
- **`pane-emulator.ts`**：headless 模拟器用于 agent read_screen / run_command，不需要剪贴板功能，**不需要修改**。PaneEmulator 的 `EmulatorStreamListener` 接口不变。
