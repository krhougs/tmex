# Prompt 存档

## 背景

GitHub issue #32：watch push 通知点开会跳到 `http://127.0.0.1:9883/`（gateway loopback bind 地址），走域名/反代访问时点不开。issue 原文给的修法（服务端校验 `siteUrl` / 从 `Origin`、`X-Forwarded-*` 推导公网 base）被用户判定为错误方向。

## 用户原始 prompt（按时间顺序）

### 1. 触发任务（issue 浏览）

> 看一下issue list 别干活 只告诉我有什么事情要处理

### 2. 指定修复 #32 并给出正确方向

> 先修 32，issue里的修法是错误的，你需要扫描代码里所有的toast通知中的app内跳转，把所有的切换window pane的行为替换成sidebar device list中的同款行为，把跳转到其他页面的行为替换为走router库操作路由

### 3. 计划阶段追加第二个修复（Fix B）

> 然后顺手修一个问题 现在终端页面遇到不存在的pane和window会直接空白 你需要补一个友好的找不到窗口提示 同时补上loading和重连状态 重连时需要能看得清已有的终端内容

### 4. 批准并下达执行约束

> 按照项目规范执行计划，修复完成时commit内包含close issue 记得开worktree
> （effort 设为 ultracode）

## 交付约束

- 在 git worktree 内实施（分支 `worktree-issue32-toast-spa-nav-terminal-states`）。
- 先存档，再干活。
- 完成时 commit message 包含 `Closes #32`。
- 三套环境规范、严禁触碰生产 tmex（9883 常驻服务），验证一律仓内临时实例。
- 复用现成 i18n key，禁止 lint/format 生成文件。
