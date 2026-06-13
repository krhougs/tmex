# 已知问题（Known Issues）

本文件登记尚未解决的已知问题。解决后从本文件移除（并在对应模块文档留存背景）。

## KI-1：生产打包未包含 ghostty-vt.wasm（gateway run_command/流式读屏）

- **背景**：`apps/gateway` 的 agent 终端工具改用服务端 headless ghostty（`packages/ghostty-terminal/src/headless.ts`）。wasm 通过 `new URL('./assets/ghostty-vt.wasm', import.meta.url)` 加载，跨 Vite/Bun 通用。
- **现状**：`bun run`（dev）与 `bun test` 从源码路径加载 wasm，正常工作；`bun build --target bun` 能编译，但**不会把 `ghostty-vt.wasm` 拷进 `dist`**。bundled `index.js` 的 `import.meta.url` 相对解析指向 `dist/assets/ghostty-vt.wasm`，生产运行时该文件缺失 → headless ghostty 加载失败（run_command / 流式读屏不可用，退回 capture 行为）。
- **影响范围**：仅生产打包安装版（`tmex upgrade` 流程）；dev/test 不受影响。
- **解决方向**：在 gateway 打包/资源生成流程（`build:tmex:resources` / install 链路）把 `ghostty-vt.wasm` 拷进 gateway 运行资源目录，并确保 headless 加载器在生产能定位到它（必要时加资源路径解析/env 覆盖）。
- **详情**：`docs/agent/2026061303-run-command-headless-ghostty.md`。

## KI-2：缺真 tmux 全链路 e2e 集成测试（run_command）

- **背景**：run_command/流式读屏的各层已分别单测覆盖（真 OSC 字节过 parser、真 ghostty wasm、run_command 全分支以 fake emulator）。
- **现状**：缺一条「真 tmux → control-mode 流 → parser → emulator → run_command」的端到端集成测试（验证长输出不丢/退出码正确/vim 等 alternate 屏被拒）。
- **解决方向**：参考 `local-external-connection.integration.test.ts` 的 `-L` 临时 socket 模式，起带 control-mode 流的真实会话跑 run_command。
- **详情**：`docs/agent/2026061303-run-command-headless-ghostty.md`。
