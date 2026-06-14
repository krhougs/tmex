# Prompt 存档：e2e 拖垮生产 tmex —— 隔离 + 韧性加固

## 背景
2026-06-14 生产 tmex（launchd 常驻，9883）一次进程数耗尽崩溃。只读排查后定位为 e2e 测试与生产共用默认 tmux socket / 端口配置雷 / gateway EAGAIN 抛 unhandledRejection / 历史 fifo 孤儿死槽四层成因。本目录存档修复任务的对话 prompt 与计划。

## 对话 prompt（按时间）

1. 刚刚生产服务挂了，帮我看看发生了什么，不要动任何代码
2. 看一下 e2e 测试为什么会写出这种东西来
3. 细节一点，短时间疯狂 create/destroy 是怎么发生的
4. 怎么修复？
5. （goal）按照项目规范执行 plan，善用 subagent，确保这次任务不会改动任何测试的业务行为

## 关键约束
- 严禁触碰生产 tmex 安装目录 / 常驻服务进程；验证一律仓库内临时实例。
- 三套环境（development/test/production）；接线键经 loadEnv 注入。
- 不对生成文件 lint/format。
- **本次硬约束：不改动任何现有测试的业务行为**（只动 socket 隔离、端口、guard、gateway 韧性等管线）。
- Layer 3 改生产热路径，只有发版 + `tmex upgrade` 才在生产生效，由用户执行。
