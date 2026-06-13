# Plan-00：Agent 写入模式开关常驻 + 浏览器记忆 + 作为新 session 默认值

## 背景

Agent 聊天输入区有一个 writeMode 开关(`auto` 自动执行 / `confirm` 写入前确认),目前实现(`agent-tab.tsx:555`)只在 `activeSession` 存在时渲染,且只能改「已存在 session」的 writeMode。用户希望:开关常驻、状态在浏览器记忆、并作为新建 session 的默认写入模式(即 session 创建前开关就生效)。

## 现状

- FE store `useAgentStore`(`apps/fe/src/stores/agent.ts`,zustand + persist):persist 仅 `partialize` 出 `activeSessionId`;`createSession`(:728)POST `/api/agent/sessions` 时**不带** writeMode。
- 后端 `POST /api/agent/sessions`(`apps/gateway/src/api/agent.ts:308/358`)**已支持** `body.writeMode`(校验 `WRITE_MODES`,落库;DB 默认 `confirm`,`db/schema.ts:165`)。→ **无需后端改动**。
- UI:`writeModeControl` 在 `activeSession` 时才给出 `<Switch>`,`checked = session.writeMode === 'auto'`,`onCheckedChange` 调 `setWriteMode(session.id, ...)`。

## 方案(纯前端)

### store(`apps/fe/src/stores/agent.ts`)
1. 新增 state `defaultWriteMode: AgentWriteMode`(初值 `'confirm'`)。
2. 新增 action `setDefaultWriteMode(mode: AgentWriteMode): void`。
3. `persist.partialize` 增加 `defaultWriteMode`(浏览器记忆)。
4. `CreateSessionOptions` 增加可选 `writeMode?: AgentWriteMode`。
5. `createSession` 的 POST body 增加 `writeMode: options?.writeMode ?? get().defaultWriteMode`。

### UI(`apps/fe/src/components/agent-panel/agent-tab.tsx`)
6. `writeModeControl` 改为**永远渲染**(不再 `activeSession ? ... : undefined`)。
7. 取值/写值按是否有 active session 分支:
   - 有 active session:`checked = activeSession.writeMode === 'auto'`;切换时 `setWriteMode(session.id, mode)` **并** `setDefaultWriteMode(mode)`(让记忆跟随最近一次选择)。`disabled = isOrphan`。
   - 无 active session(draft/空):`checked = defaultWriteMode === 'auto'`;切换时仅 `setDefaultWriteMode(mode)`。不 disabled。

## 验收

1. 无 session 时开关可见可切换,刷新页面后保持(localStorage `tmex-agent`)。
2. 在该默认值下新建 session,新 session 的 `writeMode` = 记忆值(后端落库一致)。
3. 已有 session 时开关行为不回退(仍改该 session),且把选择写进默认值。
4. orphan(只读)session 开关 disabled。
5. `tsc` 通过。

## 注意

- 不碰后端;不碰生成文件(i18n 已有 `agent.writeMode.auto/confirm` key)。
