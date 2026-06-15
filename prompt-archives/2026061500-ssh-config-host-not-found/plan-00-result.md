# 执行结果：SSH 设备 sshConfigRef 劫持 host + 真实错误透出

## 结论

根因已修复并经多层验证（单测 / e2e / 真实数据实测）。worktree：`worktree-debug-pve-host-not-found`（base = main）。

## 根因复盘

`sshConfigRef` 后端语义（ssh config 的 Host 别名，host 的替代项）与前端用法（被当成
「必填的 config 文件路径」、对所有 SSH 设备预填 `~/.ssh/config`）冲突。后端 `resolveSshConnectConfig`
不分 authMode 一律 `ssh -G <ref>` 并用解析出的 host 覆盖 `device.host`：

```
ssh -G ~/.ssh/config  ->  hostname /users/krhougs/.ssh/config（字面量路径）
```

→ 覆盖真实 IP `10.110.89.254` → `getaddrinfo ENOTFOUND` → 归类为 `host_not_found` 兜底文案。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `apps/gateway/src/tmux-client/ssh-connect-config.ts` | `resolveSshConfigRef` 仅在 `authMode === 'configRef'` 时调用；移除 `resolveImplicitIdentityFilesForAgentAuth` 里 legacy 的 `\|\| device.sshConfigRef?.trim()` 守卫 |
| `apps/gateway/src/push/connection-alerts.ts` | `notify()` 持久化时把 `rawMessage` 拼进 `last_error`（与 friendly 不同才拼），WS/Telegram 不变 |
| `apps/fe/src/pages/DevicesPage.tsx` | SSH Config 输入框从「连接信息」移到「认证方式」二级设置，仅 `configRef` 出现+必填；默认值改空；create 仅 configRef 带该字段，update 非 configRef 显式清空（清理脏数据）；auth select 与 ssh-config-ref 输入加 data-testid |
| `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json` | 新增 `device.sshConfigRefPlaceholder` / `device.sshConfigRefHint`（澄清是 Host 别名而非文件路径），`build:i18n` 重新生成 resources.ts / types.ts |
| `apps/gateway/src/tmux-client/ssh-connect-config.test.ts` | 回归测试：非 configRef 残留 sshConfigRef 不得跑 `ssh -G`、host 用 device.host |
| `apps/gateway/src/push/connection-alerts.test.ts` | 断言 last_error 同时含 friendly + raw |
| `apps/fe/tests/devices.spec.ts` | e2e：SSH Config 字段仅在 configRef 认证方式出现 |

## 验证

- **单测**：gateway 全量 572 pass / 0 fail；shared 53 pass。新增回归测试先红后绿。
- **类型**：FE `tsc --noEmit` 干净（exit 0）。gateway 既有 tsc 噪声与本次改动无关（不在改动文件内）。
- **Lint**：改动文件未引入新 biome 问题（仅有的我引入的换行已对齐 biome；其余为既有未格式化代码）。
- **e2e**：`bun run test:e2e devices.spec.ts` 2 passed（新 SSH Config 用例 + 既有 local 用例无回归）。
- **视觉自验**：无头 Chromium 截图 `shot-agent-mode.png` / `shot-configref-mode.png`：agent 模式无 SSH Config 字段；configRef 模式字段+hint 正确出现在认证区。
- **真实数据实测**（dev DB 快照，未在远端建会话）：
  - `pve`（password,22）：resolved host = `10.110.89.254` ✅，TCP 22 可达 ✅（证明旧 host_not_found 是误报）。
  - `pve2`（agent,23333）：resolved host = `10.110.89.254` ✅；TCP 23333 不可达 → 修复后会暴露真实的端口/连接错误，而非误导性的 host_not_found。

## 对用户两点诉求的回应

1. **真实错误**：`last_error` 现含 raw（如 `getaddrinfo ...`）；且根因修复后 pve 不再误报 host_not_found，
   pve2 会显示真实端口错误。分类器友好文案保留给 badge 标签，raw 进 tooltip + 持久化。
2. **连不上**：根因为 sshConfigRef 劫持 host，已修复；实测 pve 解析到真实 IP 且 22 端口可达。

## 既有脏数据

后端门控后 pve/pve2 残留的 `sshConfigRef` 自动失效（read-time 忽略），无需迁移；用户编辑保存任一设备时
`buildUpdatePayload` 也会清空该字段。pve2 若确为端口问题，需用户核对 23333。

## 对抗式 review（多 agent 工作流）

3 个维度（后端 / 错误透出 / 前端）并行评审 + 逐条对抗式复核。复核结论：

- **确认 1 条真实问题（已修）**：`unknown` 错误类的友好文案模板为 `"Connection failed: {{message}}"`，
  已内嵌 raw；原 `last_error` 拼接判据 `rawMessage !== friendlyMessage` 会再拼一次，导致 raw 重复
  （`"Connection failed: X\nX"`）。已改为 `rawMessage && !friendlyMessage.includes(rawMessage)`，
  并新增 unknown 类不重复的单测。其余分类（host_not_found/auth_failed 等）模板不含 `{{message}}`，
  拼接正常。
- 其余候选问题经复核为误报（属非目标或既有行为），未采纳。

最终全量：gateway 573 pass / 0 fail。
