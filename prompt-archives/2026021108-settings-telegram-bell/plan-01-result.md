# Plan 01 执行结果

时间：2026-02-11

## 变更概览

### 1. 滚动策略修复
- 在 `apps/fe/src/layouts/RootLayout.tsx` 增加基于路由的滚动白名单判断。
- 白名单路由：`/`、`/devices`、`/settings`。
- 白名单路由主内容区使用 `overflow-y-auto`，其余路由保持 `overflow-hidden`。

### 2. 恢复设备管理入口并保留设置入口
- 在 `apps/fe/src/components/Sidebar.tsx` 底部展开态恢复“管理设备”入口，并与“设置”并列。
- 折叠态改为两个图标快捷按钮（管理设备 + 设置）。
- 空设备状态恢复“添加设备”主入口，同时保留“打开设置”辅助入口。

### 3. 归档补充
- 已在 `plan-prompt.md` 追加本轮问题与确认决策。
- 已新增 `plan-01.md` 记录实施计划。

## 验证结果

### TypeScript 编译
- `bunx tsc -p apps/fe/tsconfig.json --noEmit` ✅

### E2E 回归
- `bun run --cwd apps/fe test:e2e -- tests/tmux-mobile.e2e.spec.ts -g "iPhone 尺寸下顶栏不应挤在一起"` ✅
- 额外终端用例回归在当前环境中受端口探测限制，`run-e2e.ts` 未找到可用端口而提前退出（与本次 UI 改动无直接关联）。

## 结果结论

本轮目标已完成：
1. 设备列表页与设置页可滚动。
2. 设备管理入口已恢复，并与设置入口并列。
3. 终端页滚动策略未被放开，保持原有行为。
