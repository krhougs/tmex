# 修复移动端窗口关闭按钮不可见但可点（issue #2）

## 背景

GitHub issue krhougs/tmex#2：移动端视口下，侧栏窗口/面板列表的关闭按钮（×）不可见但点击热区仍然有效，单击直接 kill tmux window/pane，无任何视觉提示和确认。

根因在 `apps/fe/src/components/page-layouts/components/sidebar-device-list.tsx` 两处关闭按钮（关闭窗口约 417 行、关闭面板约 469 行）：

```
isPaneSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
```

- 触屏设备没有 hover，`group-hover:` 永远不触发（Tailwind 4 的 hover variant 被 `@media (hover: hover)` 包裹），按钮停留在 `opacity: 0`；
- `opacity: 0` 不关闭 pointer events，热区仍在，点击直接调 store 的 `closeWindow` / `closePane`，无确认。

## 方案（用户确认只做 1、3，跳过加大触摸目标/换图标）

1. **触屏常驻可见**：两处按钮 className 追加 arbitrary variant `[@media(pointer:coarse)]:opacity-100`。项目 Tailwind 4.0.6 无内置 `pointer-coarse:`（4.1 才有），故用 arbitrary variant，不升级依赖。用 pointer 能力检测而非 768px 屏宽判断（iPad/触屏笔记本场景）。
2. **关闭确认（全平台）**：在 `SideBarDeviceList` 顶层加 `closeCandidate` state + shadcn `AlertDialog`（参考 `DevicesPage.tsx` 删除设备确认的写法）。关闭按钮点击只设置 candidate，确认后才执行原 `handleCloseWindow` / `closePane` 逻辑。透传链（DeviceSection → WindowItem）的回调签名不变。对话框描述带窗口名/面板标题（从 candidate 信息携带）。

## 注意事项

- store 的 `closePane` 真实签名是 `(deviceId, paneId)`（`stores/tmux.ts:74`），组件 props 声明的 `(deviceId, windowId, paneId, paneCount)` 多余参数一直被忽略，包装时按真实签名调用。
- 硬编码的 `title="Close window"` / `title="Close pane"` 顺带 i18n 化。
- i18n 文案加在 `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json` 的 `window` 段，然后跑 `bun run build:i18n` 重新生成 `resources.ts` / `types.ts`；严禁手动 lint/format 生成文件。
- 严禁触碰本机生产 tmex（9883 / `~/Library/Application Support/tmex/`），验证用仓库内临时实例并显式覆盖 app.env 继承的环境变量。

## 验收

- 触屏（pointer: coarse）模拟下关闭按钮可见；桌面 hover 行为不变。
- 点击关闭按钮先出确认对话框，取消不关闭，确认后窗口/面板被关闭；关闭当前选中窗口仍正确回退导航到 `/devices`。
- typecheck / lint（仅源文件）通过；`build:i18n` 生成物干净。
