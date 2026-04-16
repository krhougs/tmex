# 执行结果总结

## 根因

zsh 在 tmux 内（TERM=screen-256color/tmux-256color）会用 **screen/tmux 风格的设标题序列** `\x1bk<title>\x1b\\` 取代 `\x1b]2;<title>\x07`，把当前命令名作为窗口 title 推送。

`pane-title-parser` 只识别 OSC（`ESC ]`）开头的标题序列，遇到 `ESC k` 时走到 `esc` phase 的兜底分支，把 `ESC k` 两字节透传给前端，紧接的 title 文本（如 `echo`）则在 `normal` phase 被当作普通字符 push 给前端。前端 ghostty 不识别 `ESC k`，跳过后把 `echo` 当文字渲染，与命令真实输出 `test` 拼接出 `echotest`。

实测捕获 `pipe-pane` 字节流确认了 `\x1b 6b 65 63 68 6f 1b 5c 74 65 73 74 0d 0a` (`ESC k echo ESC \ test \r \n`) 这一段。

## 修改

- `apps/gateway/src/tmux-client/pane-title-parser.ts`
  - 新增 `screen-title` / `screen-title-st` 两个 phase。
  - `esc` phase 收到 `0x6b`（`k`）时切到 `screen-title`，收集 title 字节直到 `BEL` 或 `ESC \`，emit title，整段序列不再泄漏到 output。
  - 显式补齐了原来 `osc-st` 隐式分支的 `if (phase === 'osc-st')` 判定，让两套终止符共享同一份处理结构。
- `apps/gateway/src/tmux-client/pane-title-parser.test.ts`
  - 新增三个用例：ESC k + ST、ESC k + BEL、跨 push 调用边界。

## 验证

- `bun test apps/gateway/src/tmux-client/pane-title-parser.test.ts` → 5 pass。
- `bun test apps/gateway/src/tmux-client/` → 43 pass。
- 用真实 `pipe-pane` 字节回灌新版 parser，`echo` 作为 title emit，output 仅剩 `test\r\n`。

## 注意

- 修复只影响 gateway 侧 OSC/screen-title 解析，不动前端 contenteditable，与「bug 不在 contenteditable」的判断一致。
- 没有触碰生成文件、没跑 `bun run lint:fix --unsafe`，只对改动的两个文件做了 `bunx biome format --write`。
