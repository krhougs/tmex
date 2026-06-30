# Pane CWD 显示与"在当前目录新建窗口"

## 用户原始需求

1. pane list 中显示进程名的那一行改为 `${process_name}@${current_pwd}`
2. （未获取到 pwd 的时候不显示）窗口/pane 的 context menu 中新增"在当前目录新建窗口"

## 背景

当前终端实现中没有获取 pane 的 working directory：
- tmux snapshot 的 `list-panes -F` 中抓了 `#{pane_current_command}` 但没有 `#{pane_current_path}`
- `pane-stream-parser.ts` 没有处理 OSC 7
- `TmuxPane` 接口没有 path 字段
- `PaneWireSchema` borsh 协议没有传输 path
- `createWindow` API 只接受 `name`，不接受 `cwd`

## 实现方案

### 方案选择

使用 tmux `#{pane_current_path}` 变量（而非 OSC 7），理由：
- tmux 通过 OS 级别读取前台进程 cwd（macOS `proc_pidinfo`、Linux `/proc/<pid>/cwd`）
- 不依赖 shell 配置，对所有 shell 通用
- 无需修改 pane-stream-parser

### 变更清单

#### Layer 1: 数据类型 + 协议
- `packages/shared/src/index.ts`: `TmuxPane` 加 `currentPath?: string`
- `packages/shared/src/ws-borsh/schema.ts`: `PaneWireSchema` 加 `currentPath`, `TmuxCreateWindowSchema` 加 `cwd`
- `packages/shared/src/ws-borsh/convert.ts`: encode/decode `currentPath`; 不影响向前兼容性（option 字段追加到末尾）

#### Layer 2: Gateway
- `local-external-connection.ts`: list-panes 格式加 `#{pane_current_path}`, 解析 10 个字段
- `ssh-external-connection.ts`: 同上
- `device-session-runtime.ts`: `createWindow(name?, cwd?)` 透传
- `ws/index.ts`: 解析并透传 cwd

#### Layer 3: Frontend
- `terminalMeta.ts` 或 sidebar 组件: processName 行改为 `processName@currentPath`
- `message-builder.ts`: `buildTmuxCreateWindow` 加 cwd
- `stores/tmux.ts`: `createWindow` 加 cwd 参数
- `sidebar-device-list.tsx`: window/pane context menu 加"在当前目录新建窗口"（有 cwd 时才显示）

#### Layer 4: i18n
- en_US/zh_CN/ja_JP: 加 `window.newInCwd` key

#### Layer 5: 测试
- `convert.test.ts`: 补 currentPath 序列化测试
- local/ssh connection 测试: 补 pane_current_path 快照解析
