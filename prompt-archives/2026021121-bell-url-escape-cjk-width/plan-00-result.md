# Plan 00 执行结果

时间：2026-02-11

## 完成项

1. 修复 Telegram bell 链接路径编码：
   - `deviceId`、`windowId`、`paneId` 统一使用 `encodeURIComponent`。
2. 同步修复 bell 上下文产出的 `paneUrl`，保证所有 bell 直达链接编码规则一致。
3. 更新相关测试断言（`@` -> `%40`，`%` -> `%25`）并通过。
4. 调研并接入 Unicode 宽度优化：
   - 新增依赖 `xterm-addon-unicode11@0.6.0`（peer: `xterm@^5.0.0`）。
   - `DevicePage` 初始化 xterm 时加载 `Unicode11Addon` 并激活 `terminal.unicode.activeVersion = '11'`。
5. 调整 xterm 字体栈，优先单宽与 CJK mono fallback，降低中文/emoji 视觉宽度偏差。

## 调研依据

1. xterm 官方 Addons 使用指南：
   - https://xtermjs.org/docs/guides/using-addons/
2. xterm API（Unicode handling）：
   - https://xtermjs.org/docs/api/terminal/interfaces/iunicodehandling/
3. `xterm-addon-unicode11` 包说明（用途与用法）：
   - https://www.npmjs.com/package/xterm-addon-unicode11
4. 本地包一手说明（已安装后核对）：
   - `node_modules/.bun/xterm-addon-unicode11@0.6.0/node_modules/xterm-addon-unicode11/README.md`

## 验证记录

1. Gateway 测试（带 DB/BASE_URL 环境）通过：

```bash
DATABASE_URL=/tmp/tmex-gateway-test.db TMEX_BASE_URL=http://127.0.0.1:8085 bun run --filter @tmex/gateway test
```

结果：`57 pass, 0 fail`

2. Gateway 构建通过：

```bash
bun run --filter @tmex/gateway build
```

3. Frontend 构建通过：

```bash
bun run --filter @tmex/fe build
```

## 备注

- 此次 xterm 宽度问题属于“尝试优化”：Unicode 11 宽度规则 + 字体 fallback 可改善大量场景，但最终效果仍与用户端可用字体有关。

## 追加修正（按最新反馈）

用户要求 Telegram 链接处理规则调整为：
1. 先对路径段做 `encodeURIComponent`。
2. 再按 Telegram 链接兼容规则，将整条 URL 中的 `%` 再编码一次（`%` -> `%25`）。

已在 bell HTML 链接渲染时应用该规则：
- 目标链接从：`.../windows/%401/panes/%251`
- 调整为：`.../windows/%25401/panes/%25251`

并已更新测试断言与通过验证。
