# issue #28 bun 路径解析重构 —— prompt 存档

## 背景

GitHub issue #28：「Bun detection misses Homebrew-installed binary (/opt/homebrew/bin/bun) on macOS」。
工作在 git worktree `issue-28-bun-detection`（分支 `worktree-issue-28-bun-detection`）。

调查结论（详见 plan-00.md 的 Context）：issue 诊断错误——bun 其实被检测到了（报错带出了路径），真因是 `locateBunFromShell()` 用 `zsh -lic` 交互式 shell，stdout 被 `.zshrc` 的 ANSI 控制序列污染，`trim()` 去不掉，导致返回的路径字符串夹带控制字符、`spawn` 失败。issue 建议的修复（加 homebrew 路径）因短路逻辑无效。

用户决策：采用「安装期确定 bun 路径 → 持久化到 install-meta → upgrade/doctor 复用 + 允许显式 --bun-path/TMEX_BUN_PATH 传入」方案。探测仅作兜底且修健壮。

关键技术点（已实证）：
- bun 运行时暴露 `process.versions.bun`（node 下为 undefined）；自更新链路 gateway 用 `spawn(execPath=bun, [binPath,...])` 拉起 cli，故 cli 的 `process.execPath` 就是正确 bun → 现有用户网页自更新确定性修复。
- 升级本来就会重写 install-meta（read-modify-write），故 bunPath 纳入重写字段即可，旧 meta 缺字段是一次性过渡态。

## 用户 prompt 原文（按时间）

1. `https://github.com/krhougs/tmex/issues/28 检查一下是否真的有这个问题，并检查所有支持平台是否有类似问题 记得开worktree和subagent`

2. `是不是没必要去detect用户的 已经传path进来了，而且我们可以允许传入bun二进制的位置 如果这么搞相应升级脚本和doctor也得改`

3. `你需要考虑一下现有用户的兼容性`

4. （ExitPlanMode 反馈）`升级会重建metadata`

5. （切换 ultracode 后）`开始执行`
