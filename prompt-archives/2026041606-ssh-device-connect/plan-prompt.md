# Prompt Archive

## 用户需求

- 当前实现里的 SSH connect 完全不可用，需要仔细 review 并重新设计 SSH 相关架构，让 SSH device 完全工作。
- 调试时使用开发服务器里的 `dns shanghai` 设备。
- 设计 e2e 时不要硬编码任何服务器；调试这台服务器时必须通过参数传入。

## 当前约束

- 项目使用 Bun.js，调试与验证命令默认按 Bun 环境设计。
- 本轮目标聚焦在 SSH device 主链路可用，不扩散到无关 UI／tmux 功能。
- 需要先完成根因调查与架构边界梳理，再进入实现。
- 新增约束：一个 device 只能维持一个 SSH 连接，不能出现同设备并发建立多个 SSH transport 的情况。
