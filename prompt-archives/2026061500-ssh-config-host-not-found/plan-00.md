# 修复 SSH 设备 sshConfigRef 劫持 host + 真实错误透出

## Context（背景）

dev server 上新增的 SSH 设备 `pve` / `pve2` 填了正确 IP（`10.110.89.254`）却报
`Host not found: Unable to resolve hostname`，但机器实际可连。

排查已定位根因（已实测验证）：`sshConfigRef` 字段的**后端语义**与**前端用法**冲突。

- 后端 `apps/gateway/src/tmux-client/ssh-connect-config.ts:224-225`：只要 `device.sshConfigRef`
  非空就执行 `ssh -G <ref>`，并用解析出的 host **覆盖** `device.host`，**不区分 authMode**。
- 前端 `apps/fe/src/pages/DevicesPage.tsx`：commit `7c8be84` 把 `sshConfigRef` 变成
  **所有 SSH 设备的必填项**，默认预填 `~/.ssh/config`（commit 把它当成「config 文件路径」，
  见 i18n `sshConfigRequired` = "SSH config path is required"）。

`pve`（authMode=password）残留默认值 `~/.ssh/config` → 后端执行
`ssh -G ~/.ssh/config`，ssh 把文件路径当主机名，HostName 回落成字面量
`/users/krhougs/.ssh/config` → 覆盖真实 IP → ssh2 对该路径做 DNS 解析 →
`getaddrinfo ENOTFOUND` → 被 `classifySshError` 归类为 `host_not_found` 兜底文案。

实测验证：
```
$ ssh -G ~/.ssh/config
hostname /users/krhougs/.ssh/config      ← 垃圾主机名
$ ssh -G 10.110.89.254
hostname 10.110.89.254                    ← 正常
```
对照：能连上的 `Dns` 设备无 `sshConfigRef` 字段；`pve/pve2` 才带 `~/.ssh/config`。

`sshConfigRef` 的真实含义是 **ssh config 里的 Host 别名**（喂给 `ssh -G <别名>`），
是 host 的*替代项*（API 校验 `sshRequiresHost` = "requires host **or** sshConfigRef"），
**不是** config 文件路径。前端的预填/必填把用户带偏了。

## 目标

1. **根因修复**：非 `configRef` 认证模式下，后端忽略 `sshConfigRef`，直接用 `device.host`。
2. **前端**：把 SSH Config 输入框从「连接信息」区移到「认证方式」下的二级设置，
   **仅当认证方式选择 `SSH Config` 时**出现并校验；去掉对所有 SSH 设备的预填默认值；
   澄清它是 Host 别名而非文件路径。
3. **真实错误透出**：把 raw 错误拼进持久化的 `last_error`，让设备页/tooltip
   刷新后也能看到真实错误（用户选定方案：raw 拼进 last_error，不加 DB 列）。

## 执行前置（AGENTS.md：先存档，再干活）

在 `prompt-archives/` 按规则建目录（如 `2026061500-ssh-config-host-not-found`），创建
`plan-prompt.md` 存档本次需求 prompt，并把本计划另存为 `plan-00.md`；实现完成后写
`plan-00-result.md` 总结。

## 改动详情

### 1. 后端：sshConfigRef 仅在 configRef 模式生效（根因）

文件：`apps/gateway/src/tmux-client/ssh-connect-config.ts`

- L224：改为按 authMode 闸门解析
  ```ts
  const resolvedConfig =
    device.authMode === 'configRef' ? resolveSshConfigRef(device, deps) : null;
  ```
  下游 `host = resolvedConfig?.host ?? device.host` 等已全部用 `?.` 容错 null；
  非 configRef 模式 → `resolvedConfig` 为 null → 直接用 `device.host`。
  configRef 模式行为不变（ref 为空时仍在 `case 'configRef'` 抛 `ssh_config_ref_missing`）。
- L193 `resolveImplicitIdentityFilesForAgentAuth`：去掉 `|| device.sshConfigRef?.trim()`
  这个 legacy 条件，改为仅 `if (device.authMode !== 'agent') return [];`。
  这样 agent 模式即便有残留 `sshConfigRef`，仍能正常做隐式 identity 发现。

风险评估（来自代码勘探）：
- configRef / password / key 模式：安全，不依赖被门控的解析。
- agent 模式：implicit fallback 本就只对 agent 模式有意义；改动后行为更正确。
- auto 模式：当前会把 sshConfigRef 的 IdentityFile 当 fallback——这正是「configRef 概念
  泄漏到其它模式」的 bug 表现，门控掉是预期行为。auto 仍可走 envAgent / device.privateKeyEnc
  / device.passwordEnc。
- Files 子系统 `files/ssh-command.ts`：configRef 分支已自带 `authMode === 'configRef'` 判断，
  主路径读 `cfg.host`（修复后即 device.host），**无需改动**。

### 2. 前端：SSH Config 字段移入认证方式二级设置

文件：`apps/fe/src/pages/DevicesPage.tsx`

- **删除**连接信息区的 sshConfigRef `<div>`（L740-752，位于 `sectionConnection` 的 grid 内）。
- **新增** configRef-only 块，加在认证区（`sectionAuth`）key 块之后、`</section>`（~L830）之前：
  ```tsx
  {formData.authMode === 'configRef' && (
    <div className="space-y-1.5">
      {fieldLabel(`${mode}-device-ssh-config-ref`, t('device.authConfigRef'), true)}
      <Input id={`${mode}-device-ssh-config-ref`} type="text"
        value={formData.sshConfigRef}
        onChange={(e) => setFormData((d) => ({ ...d, sshConfigRef: e.target.value }))}
        placeholder={t('device.sshConfigRefPlaceholder')}
        aria-invalid={attempted && !formData.sshConfigRef.trim()} />
      <p className="text-[11px] text-muted-foreground">{t('device.sshConfigRefHint')}</p>
    </div>
  )}
  ```
- `createDefaultFormValues`（L86）：新建默认值 `sshConfigRef: '~/.ssh/config'` → `''`。
- `validateDeviceForm`（L196-198）：`sshConfigRequired` 校验仅当 `values.authMode === 'configRef'`。
- `buildCreatePayload`（L127）：仅当 `authMode === 'configRef'` 时带 `sshConfigRef`。
- `buildUpdatePayload`（L159）：`sshConfigRef: values.authMode === 'configRef' ? values.sshConfigRef.trim() : ''`
  —— 切走 configRef 时显式清空，顺带清理已有脏数据（API `if (body.sshConfigRef !== undefined)`
  会写入空串）。

i18n（编辑源 `packages/shared/src/i18n/locales/{en_US,zh_CN,ja_JP}.json`，
**禁止直接改生成物 resources.ts/types.ts**，改完跑 `bun run build:i18n`）：
- 新增 `device.sshConfigRefPlaceholder`（例：`如 ~/.ssh/config 中的 Host 别名`）。
- 新增 `device.sshConfigRefHint`（说明：填 ssh config 里的 Host 别名，经 `ssh -G` 解析；
  不是 config 文件路径）。
- `device.authConfigRef`（"SSH Config"）继续作为认证方式选项 + 字段标签复用。

### 3. 真实错误拼进 last_error

文件：`apps/gateway/src/push/connection-alerts.ts`

- `notify()`（~L82-91）：构造持久化文案
  ```ts
  const persistedMessage =
    rawMessage && rawMessage !== friendlyMessage
      ? `${friendlyMessage}\n${rawMessage}`
      : friendlyMessage;
  ```
  把 `persistedMessage` 传给 `this.persister(device.id, persistedMessage, classified.type)`。
  WS 广播仍分别带 `message`(friendly) + `rawMessage`（实时 tooltip 不变）；Telegram 不变。

说明：badge 标签来自 `error.type` 的 i18n（短），`error.message` 只进 tooltip
（`device-status-badge.tsx:50`），故拼接后 badge 标签不受影响，刷新后 tooltip 即可见真实错误。
`ssh-external-connection.ts:327` 等直接写 raw 的调用先发、随后被 notify 的合并文案覆盖，无害。

### 4. 既有脏数据

后端门控后，`pve/pve2` 残留的 `sshConfigRef` 自动失效（read-time 忽略），无需 DB 迁移；
用户下次在表单编辑保存任一设备时，`buildUpdatePayload` 也会清空该字段。

## 测试

- **后端回归测试**（`apps/gateway/src/tmux-client/ssh-connect-config.test.ts`，先写失败用例）：
  新增一例 —— authMode=`password`（或 `auto`）+ `host: '10.0.0.1'` + `sshConfigRef: 'whatever'`，
  注入会改写 host 的 `runSync` stub，断言 `resolveSshConnectConfig` 返回的
  `host === '10.0.0.1'`（即未调用 `ssh -G` 覆盖）。这是复现根因的失败测试。
  既有 configRef / agent 用例应继续通过。
- **错误透出测试**（`apps/gateway/src/push/connection-alerts.test.ts`）：断言 raw 与 friendly
  不同时，persister 收到的文案包含 rawMessage。
- **前端**：`apps/fe/tests/devices.spec.ts` 现仅覆盖 local 设备；新增/补充 SSH 表单用例——
  默认 authMode 下不渲染 SSH Config 输入框、不因其为空而校验失败；切到 `SSH Config`
  认证方式后该框出现且必填。

## 端到端验证

1. `bun test`（gateway + shared 受影响包）全绿。
2. `bun run build:i18n` 后确认 `resources.ts` 含新 key，且无 lint 报错（生成物不手动改）。
3. 仓库内起临时实例（显式覆盖 `GATEWAY_PORT` / `TMEX_FE_DIST_DIR` / `TMEX_BIND_HOST`，
   不碰 9883 生产；参考 e2e 用 9885/9665），新建一台 password SSH 设备指向可达主机、
   不填 SSH Config，确认能连上、`tmuxAvailable` 为真。
4. 故意填错主机名，确认设备页 tooltip 刷新后能看到真实 `getaddrinfo ...` 而非仅兜底文案。
5. 用无头浏览器截图核对表单：默认认证方式下无 SSH Config 框；选 `SSH Config` 后出现且带 hint。

## 非目标

- 不放宽「host 必填」（configRef 模式仍要求 host，保持现状，缩小改动面）。
- 不新增 DB 列（按用户选定：raw 拼进 last_error）。
- 不改 `classifySshError` 的分类映射逻辑（仅在持久化层补 raw）。
